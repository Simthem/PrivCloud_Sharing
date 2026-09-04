import "reflect-metadata";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { PdfSigningService } from "src/signing/pdf-signing.service";
import { createUnitTestRunner } from "./unit-test";

const forge = require("node-forge");
const { testCase, run } = createUnitTestRunner("RFC 3161 PDF timestamping");

const oid = (value: string) =>
  forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.OID,
    false,
    forge.asn1.oidToDer(value).getBytes(),
  );
const sequence = (value: any[]) =>
  forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    value,
  );
const set = (value: any[]) =>
  forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    value,
  );
const integer = (value: number | Buffer) =>
  forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.INTEGER,
    false,
    Buffer.isBuffer(value)
      ? value.toString("binary")
      : forge.asn1.integerToDer(value).getBytes(),
  );
const octets = (value: Buffer) =>
  forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.OCTETSTRING,
    false,
    value.toString("binary"),
  );
const algorithm = (algorithmOid: string) =>
  sequence([
    oid(algorithmOid),
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.NULL,
      false,
      "",
    ),
  ]);

const createCertificate = (commonName: string, timeStamping = false) => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  // X.509 serial numbers are positive ASN.1 INTEGERs. Prefixing the random
  // tail with 01 both keeps the fixture DER-valid and continuously exercises
  // the historical 01ab... serial comparison edge case.
  const serial = crypto.randomBytes(8);
  serial[0] = 1;
  certificate.serialNumber = serial.toString("hex");
  certificate.validity.notBefore = new Date("2025-01-01T00:00:00.000Z");
  certificate.validity.notAfter = new Date("2030-01-01T00:00:00.000Z");
  const attributes = [{ name: "commonName", value: commonName }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyCertSign: true,
      critical: true,
    },
    ...(timeStamping
      ? [{ name: "extKeyUsage", timeStamping: true, critical: true }]
      : []),
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return { certificate, privateKey: keys.privateKey };
};

const createTimestampResponse = (
  imprint: Buffer,
  nonce: Buffer,
  tsa: ReturnType<typeof createCertificate>,
) => {
  const sha256Oid = "2.16.840.1.101.3.4.2.1";
  const tstInfoOid = "1.2.840.113549.1.9.16.1.4";
  const tstInfo = sequence([
    integer(1),
    oid("1.2.3.4.5.6"),
    sequence([algorithm(sha256Oid), octets(imprint)]),
    integer(Buffer.from("0102030405", "hex")),
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.GENERALIZEDTIME,
      false,
      "20260902100000Z",
    ),
    integer(nonce),
  ]);
  const tstInfoDer = Buffer.from(
    forge.asn1.toDer(tstInfo).getBytes(),
    "binary",
  );
  const certificateAsn1 = forge.pki.certificateToAsn1(tsa.certificate);
  const certificateDer = Buffer.from(
    forge.asn1.toDer(certificateAsn1).getBytes(),
    "binary",
  );

  const attribute = (attributeOid: string, value: any) =>
    sequence([oid(attributeOid), set([value])]);
  const signingCertificateV2 = sequence([
    sequence([
      sequence([
        octets(crypto.createHash("sha256").update(certificateDer).digest()),
      ]),
    ]),
  ]);
  const signedAttributes = forge.asn1.create(
    forge.asn1.Class.CONTEXT_SPECIFIC,
    0,
    true,
    [
      attribute("1.2.840.113549.1.9.3", oid(tstInfoOid)),
      attribute(
        "1.2.840.113549.1.9.4",
        octets(crypto.createHash("sha256").update(tstInfoDer).digest()),
      ),
      attribute("1.2.840.113549.1.9.16.2.47", signingCertificateV2),
    ],
  );
  const attributesDer = Buffer.from(
    forge.asn1
      .toDer(
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SET,
          true,
          signedAttributes.value,
        ),
      )
      .getBytes(),
    "binary",
  );
  const digest = forge.md.sha256.create();
  digest.update(attributesDer.toString("binary"));
  const signature = Buffer.from(
    tsa.privateKey.sign(digest, "RSASSA-PKCS1-V1_5"),
    "binary",
  );
  const signerInfo = sequence([
    integer(1),
    sequence([
      forge.pki.distinguishedNameToAsn1(tsa.certificate.issuer),
      integer(Buffer.from(tsa.certificate.serialNumber, "hex")),
    ]),
    algorithm(sha256Oid),
    signedAttributes,
    algorithm("1.2.840.113549.1.1.11"),
    octets(signature),
  ]);
  const signedData = sequence([
    integer(3),
    set([algorithm(sha256Oid)]),
    sequence([
      oid(tstInfoOid),
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        octets(tstInfoDer),
      ]),
    ]),
    forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      certificateAsn1,
    ]),
    set([signerInfo]),
  ]);
  const token = sequence([
    oid("1.2.840.113549.1.7.2"),
    forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData]),
  ]);
  const response = sequence([sequence([integer(0)]), token]);
  return Buffer.from(forge.asn1.toDer(response).getBytes(), "binary");
};

const certificateFingerprint = (certificate: any) =>
  crypto
    .createHash("sha256")
    .update(
      Buffer.from(
        forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
        "binary",
      ),
    )
    .digest("hex");

const requireBuffer = (value: unknown, label: string): Buffer => {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be a Buffer`);
  }
  return value;
};

const requestValues = (body: unknown) => {
  const safeBody = requireBuffer(body, "RFC 3161 request body");
  const request = forge.asn1.fromDer(safeBody.toString("binary"), true);
  return {
    imprint: Buffer.from(request.value[1].value[1].value, "binary"),
    nonce: Buffer.from(request.value[2].value, "binary"),
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
    const parsed = forge.asn1.fromDer(requestBody.toString("binary"), true);

    assert.equal(forge.asn1.derToInteger(parsed.value[0].value), 1);
    assert.equal(
      forge.asn1.derToOid(parsed.value[1].value[0].value[0].value),
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

    service.tsaTrustedCertFingerprints = new Set([
      certificateFingerprint(tsa.certificate),
    ]);
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
      const p12 = forge.pkcs12.toPkcs12Asn1(
        seal.privateKey,
        [seal.certificate],
        "",
        { algorithm: "3des" },
      );
      service.loadCertificate = async () =>
        Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
      service.requestTsa = async (_url: string, body: Buffer) => {
        const { imprint, nonce } = requestValues(body);
        return createTimestampResponse(imprint, nonce, tsa);
      };

      const cms = await service.signDigest(crypto.randomBytes(32));
      const contentInfo = forge.asn1.fromDer(cms.toString("binary"), true);
      const signedData = contentInfo.value[1].value[0];
      const signerInfo = signedData.value[signedData.value.length - 1].value[0];
      const unsignedAttributes = signerInfo.value[signerInfo.value.length - 1];
      assert.equal(
        unsignedAttributes.tagClass,
        forge.asn1.Class.CONTEXT_SPECIFIC,
      );
      assert.equal(unsignedAttributes.type, 1);
      assert.equal(
        forge.asn1.derToOid(unsignedAttributes.value[0].value[0].value),
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
