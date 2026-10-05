import "reflect-metadata";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  asn1,
  Asn1Class,
  Asn1Node,
  Asn1Type,
  children,
  encodeDer,
  parseCertificate,
  parseDer,
  readOctets,
  readOid,
  readSmallInteger,
} from "src/signing/asn1-der.util";
import { PdfSigningService } from "src/signing/pdf-signing.service";
import {
  createTestCertificate,
  createTestPkcs12,
  TestCertificate,
} from "./signing-certificate.fixture";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("RFC 3161 PDF timestamping");

const createCertificate = (
  commonName: string,
  timeStamping = false,
  publicExponent = 0x10001,
) => createTestCertificate({ commonName, timeStamping, publicExponent });

const createTimestampResponse = (
  imprint: Buffer,
  nonce: Buffer,
  tsa: TestCertificate,
  signAttributes = (attributesDer: Buffer) =>
    crypto.sign("sha256", attributesDer, tsa.privateKey),
) => {
  const sha256Oid = "2.16.840.1.101.3.4.2.1";
  const tstInfoOid = "1.2.840.113549.1.9.16.1.4";
  const tstInfo = asn1.sequence([
    asn1.integer(1),
    asn1.oid("1.2.3.4.5.6"),
    asn1.sequence([asn1.algorithm(sha256Oid), asn1.octetString(imprint)]),
    asn1.integer(Buffer.from("0102030405", "hex")),
    asn1.create(
      Asn1Class.UNIVERSAL,
      Asn1Type.GENERALIZEDTIME,
      false,
      Buffer.from("20260902100000Z", "latin1"),
    ),
    asn1.integer(nonce),
  ]);
  const tstInfoDer = encodeDer(tstInfo);

  const attribute = (attributeOid: string, value: Asn1Node) =>
    asn1.sequence([asn1.oid(attributeOid), asn1.set([value])]);
  const signingCertificateV2 = asn1.sequence([
    asn1.sequence([
      asn1.sequence([
        asn1.octetString(crypto.createHash("sha256").update(tsa.der).digest()),
      ]),
    ]),
  ]);
  const signedAttributes = [
    attribute("1.2.840.113549.1.9.3", asn1.oid(tstInfoOid)),
    attribute(
      "1.2.840.113549.1.9.4",
      asn1.octetString(crypto.createHash("sha256").update(tstInfoDer).digest()),
    ),
    attribute("1.2.840.113549.1.9.16.2.47", signingCertificateV2),
  ];
  const signature = signAttributes(encodeDer(asn1.set(signedAttributes)));
  const signerInfo = asn1.sequence([
    asn1.integer(1),
    asn1.sequence([tsa.name, asn1.integer(tsa.serial)]),
    asn1.algorithm(sha256Oid),
    asn1.context(0, signedAttributes),
    asn1.algorithm("1.2.840.113549.1.1.11"),
    asn1.octetString(signature),
  ]);
  const signedData = asn1.sequence([
    asn1.integer(3),
    asn1.set([asn1.algorithm(sha256Oid)]),
    asn1.sequence([
      asn1.oid(tstInfoOid),
      asn1.context(0, [asn1.octetString(tstInfoDer)]),
    ]),
    asn1.context(0, [parseDer(tsa.der)]),
    asn1.set([signerInfo]),
  ]);
  const token = asn1.sequence([
    asn1.oid("1.2.840.113549.1.7.2"),
    asn1.context(0, [signedData]),
  ]);
  const response = asn1.sequence([asn1.sequence([asn1.integer(0)]), token]);
  return encodeDer(response);
};

const certificateFingerprint = (certificate: TestCertificate) =>
  crypto.createHash("sha256").update(certificate.der).digest("hex");

const requireBuffer = (value: unknown, label: string): Buffer => {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be a Buffer`);
  }
  return value;
};

const requestValues = (body: unknown) => {
  const safeBody = requireBuffer(body, "RFC 3161 request body");
  const request = children(parseDer(safeBody));
  return {
    imprint: readOctets(children(request[1])[1]),
    nonce: readOctets(request[2]),
  };
};

testCase(
  "builds a DER request containing only the SHA-256 imprint and protocol metadata",
  () => {
    const service = new PdfSigningService() as any;
    const imprint = crypto
      .createHash("sha256")
      .update("document bytes stay local")
      .digest();
    const request = service.buildTimestampRequest(imprint);
    const requestBody = requireBuffer(request.body, "RFC 3161 request body");
    const parsed = children(parseDer(requestBody));

    assert.equal(readSmallInteger(parsed[0]), 1);
    assert.equal(
      readOid(children(children(parsed[1])[0])[0]),
      "2.16.840.1.101.3.4.2.1",
    );
    assert.deepEqual(requestValues(requestBody).imprint, imprint);
    assert.equal(request.nonce.length, 8);
    assert.equal(
      requestBody.includes(Buffer.from("document bytes stay local")),
      false,
    );
  },
);

testCase(
  "rejects cleartext TSA endpoints before opening a connection",
  async () => {
    const service = new PdfSigningService() as any;
    await assert.rejects(
      service.requestTsa("http://timestamp.invalid/tsr", Buffer.alloc(1)),
      /must use HTTPS/,
    );
  },
);

testCase(
  "validates the TSA token and rejects a mismatched imprint or nonce",
  () => {
    const service = new PdfSigningService() as any;
    const tsa = createCertificate("PrivCloud test TSA", true);
    const imprint = crypto.randomBytes(32);
    const nonce = Buffer.from("1020304050607080", "hex");
    const response = createTimestampResponse(imprint, nonce, tsa);

    const evidence = service.validateTimestampResponse(
      response,
      imprint,
      nonce,
    );
    assert.equal(evidence.policyOid, "1.2.3.4.5.6");
    assert.equal(
      evidence.generatedAt.toISOString(),
      "2026-09-02T10:00:00.000Z",
    );
    assert.throws(
      () =>
        service.validateTimestampResponse(
          response,
          crypto.randomBytes(32),
          nonce,
        ),
      /messageImprint does not match/,
    );
    assert.throws(
      () =>
        service.validateTimestampResponse(
          response,
          imprint,
          crypto.randomBytes(8),
        ),
      /nonce does not match/,
    );
  },
);

testCase(
  "rejects a token whose signing certificate is not reserved for timestamping",
  () => {
    const service = new PdfSigningService() as any;
    const tsa = createCertificate("Invalid test TSA", false);
    const imprint = crypto.randomBytes(32);
    const nonce = Buffer.from("1122334455667788", "hex");
    const response = createTimestampResponse(imprint, nonce, tsa);
    assert.throws(
      () => service.validateTimestampResponse(response, imprint, nonce),
      /critical timeStamping EKU/,
    );
  },
);

testCase(
  "requires the TSA chain to reach the configured trust fingerprint",
  () => {
    const service = new PdfSigningService() as any;
    const tsa = createCertificate("Pinned test TSA", true);
    const imprint = crypto.randomBytes(32);
    const nonce = Buffer.from("2233445566778899", "hex");
    const response = createTimestampResponse(imprint, nonce, tsa);

    service.tsaTrustedCertFingerprints = new Set([certificateFingerprint(tsa)]);
    assert.doesNotThrow(() =>
      service.validateTimestampResponse(response, imprint, nonce),
    );

    service.tsaTrustedCertFingerprints = new Set(["a".repeat(64)]);
    assert.throws(
      () => service.validateTimestampResponse(response, imprint, nonce),
      /does not reach a configured SHA-256 trust fingerprint/,
    );
  },
);

testCase(
  "uses OpenSSL for certificate signatures and rejects RSA exponent 3",
  () => {
    const service = new PdfSigningService() as any;
    const safe = parseCertificate(
      createCertificate("OpenSSL verification control").der,
    );
    assert.equal(
      service.verifyCertificateSignatureWithOpenSsl(safe, safe),
      true,
    );

    const lowExponent = parseCertificate(
      createCertificate("Unsafe exponent certificate", false, 3).der,
    );
    assert.equal(
      service.verifyCertificateSignatureWithOpenSsl(lowExponent, lowExponent),
      false,
    );
  },
);

testCase(
  "rejects CVE-2026-85393 signatures with extra DigestAlgorithm fields",
  () => {
    // PKCS#1 v1.5 padding around a DigestInfo whose AlgorithmIdentifier
    // carries an extra NULL: the shape node-forge accepted up to 1.4.0.
    const forgedSignature =
      (tsa: TestCertificate) => (attributesDer: Buffer) => {
        const digestInfo = encodeDer(
          asn1.sequence([
            asn1.sequence([
              asn1.oid("2.16.840.1.101.3.4.2.1"),
              asn1.null(),
              asn1.null(),
            ]),
            asn1.octetString(
              crypto.createHash("sha256").update(attributesDer).digest(),
            ),
          ]),
        );
        return crypto.privateEncrypt(
          { key: tsa.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          digestInfo,
        );
      };

    const service = new PdfSigningService() as any;
    for (const publicExponent of [0x10001, 3]) {
      const tsa = createTestCertificate({
        commonName: `Forged DigestInfo TSA e=${publicExponent}`,
        timeStamping: true,
        publicExponent,
      });
      const imprint = crypto.randomBytes(32);
      const nonce = Buffer.from("3344556677889900", "hex");
      const forged = createTimestampResponse(
        imprint,
        nonce,
        tsa,
        forgedSignature(tsa),
      );
      assert.throws(
        () => service.validateTimestampResponse(forged, imprint, nonce),
        /TSA CMS signature verification failed/,
      );
    }
  },
);

testCase(
  "embeds a validated RFC 3161 token in the detached PAdES CMS",
  async () => {
    const previousUrl = process.env.SIGNING_TSA_URL;
    const previousRequired = process.env.SIGNING_TSA_REQUIRED;
    process.env.SIGNING_TSA_URL = "https://tsa.test.invalid";
    process.env.SIGNING_TSA_REQUIRED = "true";

    try {
      const service = new PdfSigningService() as any;
      const tsa = createCertificate("PrivCloud embedding test TSA", true);
      const seal = createCertificate("PrivCloud test PDF seal", false);
      const p12 = createTestPkcs12(seal.privateKey, [seal.der], "");
      service.loadCertificate = async () => p12;
      service.requestTsa = async (_url: string, body: Buffer) => {
        const { imprint, nonce } = requestValues(body);
        return createTimestampResponse(imprint, nonce, tsa);
      };

      const cms = await service.signDigest(crypto.randomBytes(32));
      const signedData = children(children(parseDer(cms))[1])[0];
      const signerInfos = children(signedData);
      const signerInfo = children(
        children(signerInfos[signerInfos.length - 1])[0],
      );
      const unsignedAttributes = signerInfo[signerInfo.length - 1];
      assert.equal(unsignedAttributes.tagClass, Asn1Class.CONTEXT_SPECIFIC);
      assert.equal(unsignedAttributes.type, 1);
      assert.equal(
        readOid(children(children(unsignedAttributes)[0])[0]),
        "1.2.840.113549.1.9.16.2.14",
      );
    } finally {
      if (previousUrl === undefined) delete process.env.SIGNING_TSA_URL;
      else process.env.SIGNING_TSA_URL = previousUrl;
      if (previousRequired === undefined)
        delete process.env.SIGNING_TSA_REQUIRED;
      else process.env.SIGNING_TSA_REQUIRED = previousRequired;
    }
  },
);

void run();
