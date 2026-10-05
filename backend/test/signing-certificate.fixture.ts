import * as crypto from "node:crypto";
import {
  asn1,
  Asn1Class,
  Asn1Node,
  Asn1Type,
  encodeDer,
  parseDer,
} from "src/signing/asn1-der.util";
import { pkcs12MacKey, PKCS12_MAC_SHA256 } from "src/signing/pkcs12.util";

/**
 * Throwaway X.509 certificates and PKCS#12 files for the signing tests, built
 * with node:crypto so no test depends on a third-party PKI library.
 */

export type TestCertificate = {
  der: Buffer;
  pem: string;
  privateKey: crypto.KeyObject;
  serial: Buffer;
  name: Asn1Node;
};

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

const bitString = (bytes: Buffer, unusedBits = 0) =>
  asn1.create(
    Asn1Class.UNIVERSAL,
    Asn1Type.BITSTRING,
    false,
    Buffer.concat([Buffer.from([unusedBits]), bytes]),
  );

const extension = (oid: string, value: Asn1Node) =>
  asn1.sequence([
    asn1.oid(oid),
    asn1.boolean(true),
    asn1.octetString(encodeDer(value)),
  ]);

export function createTestCertificate(options: {
  commonName: string;
  timeStamping?: boolean;
  publicExponent?: number;
  issuer?: TestCertificate;
}): TestCertificate {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: options.publicExponent ?? 0x10001,
  });
  // X.509 serial numbers are positive ASN.1 INTEGERs. Prefixing the random
  // tail with 01 both keeps the fixture DER-valid and continuously exercises
  // the historical 01ab... serial comparison edge case.
  const serial = crypto.randomBytes(8);
  serial[0] = 1;
  const name = asn1.sequence([
    asn1.set([
      asn1.sequence([
        asn1.oid("2.5.4.3"),
        asn1.create(
          Asn1Class.UNIVERSAL,
          Asn1Type.UTF8,
          false,
          Buffer.from(options.commonName, "utf8"),
        ),
      ]),
    ]),
  ]);

  const tbs = encodeDer(
    asn1.sequence([
      asn1.context(0, [asn1.integer(2)]),
      asn1.integer(serial),
      asn1.algorithm(SHA256_WITH_RSA),
      options.issuer?.name ?? name,
      asn1.sequence([
        asn1.utcTime(new Date("2025-01-01T00:00:00.000Z")),
        asn1.utcTime(new Date("2030-01-01T00:00:00.000Z")),
      ]),
      name,
      parseDer(publicKey.export({ type: "spki", format: "der" })),
      asn1.context(3, [
        asn1.sequence([
          extension("2.5.29.19", asn1.sequence([asn1.boolean(true)])),
          // digitalSignature and keyCertSign
          extension("2.5.29.15", bitString(Buffer.from([0x84]), 2)),
          ...(options.timeStamping
            ? [
                extension(
                  "2.5.29.37",
                  asn1.sequence([asn1.oid("1.3.6.1.5.5.7.3.8")]),
                ),
              ]
            : []),
        ]),
      ]),
    ]),
  );
  const signature = crypto.sign(
    "sha256",
    tbs,
    options.issuer?.privateKey ?? privateKey,
  );
  const der = encodeDer(
    asn1.sequence([
      parseDer(tbs),
      asn1.algorithm(SHA256_WITH_RSA),
      bitString(signature),
    ]),
  );
  const pem =
    "-----BEGIN CERTIFICATE-----\n" +
    der
      .toString("base64")
      .match(/.{1,64}/g)
      .join("\n") +
    "\n-----END CERTIFICATE-----\n";
  return { der, pem, privateKey, serial, name };
}

const passwordToBmp = (password: string) => {
  const bytes = Buffer.alloc((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) {
    bytes.writeUInt16BE(password.charCodeAt(i), i * 2);
  }
  return bytes;
};

/**
 * PKCS#12 shaped like `openssl pkcs12 -export` with AES-256-CBC and a SHA-256
 * MAC: a shrouded key bag in a data content, certificate bags in an encrypted
 * content, and an HMAC. The other variants each break one rule of the
 * accepted profile: a SHA-1 MAC identifier, certificates under the legacy
 * PBE-SHA1-3DES identifier, a key bag in clear, or no MAC at all. Their
 * rejected parts carry random bytes, never a real legacy computation.
 */
export function createTestPkcs12(
  privateKey: crypto.KeyObject,
  certificates: Buffer[],
  password: string,
  variant:
    | "pbes2"
    | "sha1-mac"
    | "legacy-encryption"
    | "plain-key"
    | "no-mac" = "pbes2",
): Buffer {
  const iterations = 2048;

  const pbes2 = (plain: Buffer): Asn1Node[] => {
    const salt = crypto.randomBytes(8);
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    return [
      asn1.sequence([
        asn1.oid("1.2.840.113549.1.5.13"),
        asn1.sequence([
          asn1.sequence([
            asn1.oid("1.2.840.113549.1.5.12"),
            asn1.sequence([
              asn1.octetString(salt),
              asn1.integer(iterations),
              asn1.algorithm("1.2.840.113549.2.9"),
            ]),
          ]),
          asn1.sequence([
            asn1.oid("2.16.840.1.101.3.4.1.42"),
            asn1.octetString(iv),
          ]),
        ]),
      ]),
      asn1.octetString(Buffer.concat([cipher.update(plain), cipher.final()])),
    ];
  };
  const legacyIdentifierOnly = (): Asn1Node[] => [
    asn1.sequence([
      asn1.oid("1.2.840.113549.1.12.1.3"),
      asn1.sequence([
        asn1.octetString(crypto.randomBytes(8)),
        asn1.integer(iterations),
      ]),
    ]),
    asn1.octetString(crypto.randomBytes(64)),
  ];

  const bag = (oid: string, value: Asn1Node) =>
    asn1.sequence([asn1.oid(oid), asn1.context(0, [value])]);
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const keyContents = asn1.sequence([
    variant === "plain-key"
      ? bag("1.2.840.113549.1.12.10.1.1", parseDer(pkcs8))
      : bag("1.2.840.113549.1.12.10.1.2", asn1.sequence(pbes2(pkcs8))),
  ]);
  const certificateContents = asn1.sequence(
    certificates.map((certificate) =>
      bag(
        "1.2.840.113549.1.12.10.1.3",
        asn1.sequence([
          asn1.oid("1.2.840.113549.1.9.22.1"),
          asn1.context(0, [asn1.octetString(certificate)]),
        ]),
      ),
    ),
  );
  const [algorithm, encrypted] =
    variant === "legacy-encryption"
      ? legacyIdentifierOnly()
      : pbes2(encodeDer(certificateContents));

  const authSafe = encodeDer(
    asn1.sequence([
      asn1.sequence([
        asn1.oid("1.2.840.113549.1.7.6"),
        asn1.context(0, [
          asn1.sequence([
            asn1.integer(0),
            asn1.sequence([
              asn1.oid("1.2.840.113549.1.7.1"),
              algorithm,
              asn1.create(
                Asn1Class.CONTEXT_SPECIFIC,
                0,
                false,
                encrypted.value as Buffer,
              ),
            ]),
          ]),
        ]),
      ]),
      asn1.sequence([
        asn1.oid("1.2.840.113549.1.7.1"),
        asn1.context(0, [asn1.octetString(encodeDer(keyContents))]),
      ]),
    ]),
  );

  const macSalt = crypto.randomBytes(8);
  const macKey = pkcs12MacKey(
    passwordToBmp(password),
    macSalt,
    iterations,
    PKCS12_MAC_SHA256,
  );
  const mac =
    variant === "sha1-mac"
      ? crypto.randomBytes(20)
      : crypto.createHmac("sha256", macKey).update(authSafe).digest();
  const macData = asn1.sequence([
    asn1.sequence([
      asn1.algorithm(
        variant === "sha1-mac" ? "1.3.14.3.2.26" : "2.16.840.1.101.3.4.2.1",
      ),
      asn1.octetString(mac),
    ]),
    asn1.octetString(macSalt),
    asn1.integer(iterations),
  ]);

  return encodeDer(
    asn1.sequence([
      asn1.integer(3),
      asn1.sequence([
        asn1.oid("1.2.840.113549.1.7.1"),
        asn1.context(0, [asn1.octetString(authSafe)]),
      ]),
      ...(variant === "no-mac" ? [] : [macData]),
    ]),
  );
}
