import * as crypto from "crypto";
import {
  Asn1Node,
  Asn1Type,
  children,
  isUniversal,
  parseCertificate,
  ParsedCertificate,
  parseDer,
  readOctets,
  readOid,
  readSmallInteger,
} from "./asn1-der.util";

/**
 * PKCS#12 (RFC 7292) reader for the platform seal file. Only the modern
 * profile is accepted: PBES2 with PBKDF2-HMAC-SHA-2 and AES-CBC for the
 * encrypted bags, and an HMAC-SHA-2 integrity MAC. The legacy SHA-1 schemes
 * (PBE-SHA1-3DES, RC2, SHA-1 MAC) are refused, as is an unencrypted key.
 * scripts/convert-signing-p12.sh re-exports an older file to this profile.
 */

const OID = {
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  keyBag: "1.2.840.113549.1.12.10.1.1",
  pkcs8ShroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  safeContentsBag: "1.2.840.113549.1.12.10.1.6",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
};

const PBES2_CIPHERS: Record<string, { cipher: string; keyLength: number }> = {
  "2.16.840.1.101.3.4.1.2": { cipher: "aes-128-cbc", keyLength: 16 },
  "2.16.840.1.101.3.4.1.22": { cipher: "aes-192-cbc", keyLength: 24 },
  "2.16.840.1.101.3.4.1.42": { cipher: "aes-256-cbc", keyLength: 32 },
};

const PBKDF2_PRFS: Record<string, string> = {
  "1.2.840.113549.2.9": "sha256",
  "1.2.840.113549.2.10": "sha384",
  "1.2.840.113549.2.11": "sha512",
};

/** HMAC digests with their output (u) and block (v) sizes in bytes. */
const MAC_DIGESTS: Record<
  string,
  { hash: "sha256" | "sha384" | "sha512"; u: number; v: number }
> = {
  "2.16.840.1.101.3.4.2.1": { hash: "sha256", u: 32, v: 64 },
  "2.16.840.1.101.3.4.2.2": { hash: "sha384", u: 48, v: 128 },
  "2.16.840.1.101.3.4.2.3": { hash: "sha512", u: 64, v: 128 },
};

/** OpenSSL's default; fewer iterations would make a stolen file cheap to attack. */
const MIN_ITERATIONS = 2048;
const MAX_ITERATIONS = 10_000_000;

export type Pkcs12Contents = {
  privateKey?: crypto.KeyObject;
  certificates: ParsedCertificate[];
};

export function readPkcs12(der: Buffer, password: string): Pkcs12Contents {
  const pfx = children(parseDer(der));
  if (readSmallInteger(pfx[0]) !== 3) {
    throw new Error("Unsupported PKCS#12 version");
  }
  const authSafe = children(pfx[1]);
  if (readOid(authSafe[0]) !== OID.data) {
    throw new Error("Only password-integrity PKCS#12 files are supported");
  }
  const authSafeBytes = readOctets(children(authSafe[1])[0]);
  if (!pfx[2]) throw new Error("The PKCS#12 file has no integrity MAC");
  verifyMac(pfx[2], authSafeBytes, password);

  const keys: crypto.KeyObject[] = [];
  const certificates: ParsedCertificate[] = [];
  const readSafeContents = (safeContents: Asn1Node, depth = 0) => {
    if (depth > 4) throw new Error("PKCS#12 bags are nested too deeply");
    for (const bag of children(safeContents)) {
      const [bagId, bagValue] = children(bag);
      const value = children(bagValue)[0];
      switch (readOid(bagId)) {
        case OID.pkcs8ShroudedKeyBag: {
          const [algorithm, encrypted] = children(value);
          keys.push(
            crypto.createPrivateKey({
              key: decrypt(algorithm, readOctets(encrypted), password),
              format: "der",
              type: "pkcs8",
            }),
          );
          break;
        }
        case OID.certBag: {
          const [certId, certValue] = children(value);
          if (readOid(certId) === OID.x509Certificate) {
            certificates.push(
              parseCertificate(readOctets(children(certValue)[0])),
            );
          }
          break;
        }
        case OID.safeContentsBag:
          readSafeContents(value, depth + 1);
          break;
        case OID.keyBag:
          // The seal key must be protected by the password, never in clear.
          throw new Error("The PKCS#12 private key is not encrypted");
      }
    }
  };

  for (const contentInfo of children(parseDer(authSafeBytes))) {
    const [contentType, wrapped] = children(contentInfo);
    const content = children(wrapped)[0];
    switch (readOid(contentType)) {
      case OID.data:
        readSafeContents(parseDer(readOctets(content)));
        break;
      case OID.encryptedData: {
        const [, algorithm, encrypted] = children(children(content)[1]);
        readSafeContents(
          parseDer(decrypt(algorithm, readOctets(encrypted), password)),
        );
        break;
      }
      default:
        throw new Error("Unsupported PKCS#12 content type");
    }
  }

  return { privateKey: keys[0], certificates };
}

/**
 * Check the HMAC-SHA-2 integrity MAC (RFC 7292 appendix B key derivation).
 * Like OpenSSL, an empty password is tried both as an empty BMPString and as
 * no password.
 */
function verifyMac(macData: Asn1Node, content: Buffer, password: string) {
  const [digestInfo, salt, iterations] = children(macData);
  const [algorithm, digest] = children(digestInfo);
  const mac = MAC_DIGESTS[readOid(children(algorithm)[0])];
  if (!mac) {
    throw new Error(
      "Unsupported PKCS#12 MAC algorithm (SHA-256 or stronger is required)",
    );
  }

  const candidates = password
    ? [passwordToBmp(password)]
    : [passwordToBmp(""), Buffer.alloc(0)];
  const expected = readOctets(digest);
  for (const candidate of candidates) {
    const key = pkcs12MacKey(
      candidate,
      readOctets(salt),
      readIterations(iterations),
      mac,
    );
    const actual = crypto.createHmac(mac.hash, key).update(content).digest();
    if (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    ) {
      return;
    }
  }
  throw new Error("PKCS#12 MAC could not be verified. Invalid password?");
}

/** PBES2 decryption (RFC 8018): PBKDF2-HMAC-SHA-2 and AES-CBC only. */
function decrypt(algorithm: Asn1Node, data: Buffer, password: string): Buffer {
  const [algorithmId, parameters] = children(algorithm);
  if (readOid(algorithmId) !== OID.pbes2) {
    throw new Error(
      "Unsupported PKCS#12 encryption (PBES2 with AES is required)",
    );
  }

  const [keyDerivation, encryptionScheme] = children(parameters);
  if (readOid(children(keyDerivation)[0]) !== OID.pbkdf2) {
    throw new Error("Unsupported PBES2 key derivation function");
  }
  const kdfParameters = children(children(keyDerivation)[1]);
  let index = 2;
  let keyLength: number | undefined;
  if (isUniversal(kdfParameters[index], Asn1Type.INTEGER)) {
    keyLength = readSmallInteger(kdfParameters[index++]);
  }
  // An absent PRF means HMAC-SHA-1 (RFC 8018), which is refused like any
  // other PRF outside the table.
  const prf = PBKDF2_PRFS[readOid(children(kdfParameters[index])[0])];
  const scheme = PBES2_CIPHERS[readOid(children(encryptionScheme)[0])];
  if (!prf || !scheme || (keyLength && keyLength !== scheme.keyLength)) {
    throw new Error("Unsupported PBES2 parameters");
  }

  const key = crypto.pbkdf2Sync(
    Buffer.from(password, "utf8"),
    readOctets(kdfParameters[0]),
    readIterations(kdfParameters[1]),
    scheme.keyLength,
    prf,
  );
  const cipher = crypto.createDecipheriv(
    scheme.cipher,
    key,
    readOctets(children(encryptionScheme)[1]),
  );
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function readIterations(node: Asn1Node | undefined) {
  const iterations = node ? readSmallInteger(node) : 1;
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error("Unsupported PKCS#12 iteration count");
  }
  return iterations;
}

/** BMPString of the password with its two-byte terminator (RFC 7292 B.1). */
function passwordToBmp(password: string) {
  const bytes = Buffer.alloc((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) {
    bytes.writeUInt16BE(password.charCodeAt(i), i * 2);
  }
  return bytes;
}

/**
 * MAC key of RFC 7292 appendix B.2 (diversifier 3), restricted to SHA-2.
 * The PKCS#12 format fixes this derivation for the HMAC integrity check.
 */
export function pkcs12MacKey(
  password: Buffer,
  salt: Buffer,
  iterations: number,
  mac: { hash: "sha256" | "sha384" | "sha512"; u: number; v: number },
): Buffer {
  const { hash, v } = mac;
  const fill = (source: Buffer) => {
    const length = v * Math.ceil(source.length / v);
    const output = Buffer.alloc(length);
    for (let i = 0; i < length; i++) output[i] = source[i % source.length];
    return output;
  };

  // With u >= the key size, one block of the derivation is the whole key.
  let block = crypto
    .createHash(hash)
    .update(Buffer.alloc(v, 3))
    .update(fill(salt))
    .update(fill(password))
    .digest();
  for (let i = 1; i < iterations; i++) {
    block = crypto.createHash(hash).update(block).digest();
  }
  return block;
}

/** MAC parameters by digest name, for tests and tooling. */
export const PKCS12_MAC_SHA256 = MAC_DIGESTS["2.16.840.1.101.3.4.2.1"];
