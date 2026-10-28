import "reflect-metadata";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  Asn1Node,
  asn1,
  encodeDer,
  oidFromDer,
  oidToDer,
  parseDer,
  parseDerPrefix,
  readOctets,
} from "src/signing/asn1-der.util";
import { readPkcs12 } from "src/signing/pkcs12.util";
import {
  createTestCertificate,
  createTestPkcs12,
} from "./signing-certificate.fixture";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing DER and PKCS#12");

testCase("round-trips OIDs, including large arcs", () => {
  for (const oid of [
    "1.2.840.113549.1.9.16.2.47",
    "2.16.840.1.101.3.4.2.1",
    "2.999.3",
    "1.3.6.1.4.1.311.10.3.12",
  ]) {
    assert.equal(oidFromDer(oidToDer(oid)), oid);
  }
  assert.equal(
    oidToDer("1.2.840.113549.1.7.2").toString("hex"),
    "2a864886f70d010702",
  );
  assert.throws(() => oidToDer("1.40.1"), /Invalid OID/);
  assert.throws(() => oidFromDer(Buffer.from([0x2a, 0x80, 0x01])), /Invalid/);
});

testCase("decodes BER indefinite lengths and re-encodes them as DER", () => {
  const ber = Buffer.from("3080040201020500" + "0000", "hex");
  const node = parseDer(ber);
  assert.equal(encodeDer(node).toString("hex"), "3006040201020500");
  assert.deepEqual(
    readOctets((node.value as Asn1Node[])[0]),
    Buffer.from([1, 2]),
  );
});

testCase("rejects truncated, trailing and deeply nested input", () => {
  const der = encodeDer(asn1.sequence([asn1.integer(1)]));
  assert.throws(() => parseDer(der.subarray(0, der.length - 1)), /Truncated/);
  assert.throws(
    () => parseDer(Buffer.concat([der, Buffer.from([0])])),
    /Unparsed bytes/,
  );
  assert.equal(
    parseDerPrefix(Buffer.concat([der, Buffer.alloc(16)])).length,
    der.length,
  );
  const deep = Buffer.from("3080".repeat(100), "hex");
  assert.throws(() => parseDer(deep), /too deep/);
});

testCase("reads the seal key and its chain from a PBES2 file", () => {
  const root = createTestCertificate({ commonName: "PKCS#12 test root" });
  const seal = createTestCertificate({
    commonName: "PKCS#12 test seal",
    issuer: root,
  });
  const p12 = createTestPkcs12(
    seal.privateKey,
    [seal.der, root.der],
    "correct horse",
  );

  const { privateKey, certificates } = readPkcs12(p12, "correct horse");
  assert.equal(certificates.length, 2);
  assert.deepEqual(certificates[0].der, seal.der);
  assert.equal(certificates[0].x509.checkPrivateKey(privateKey), true);
  assert.equal(certificates[1].x509.checkPrivateKey(privateKey), false);
  assert.deepEqual(certificates[0].issuerDer, certificates[1].subjectDer);
  assert.throws(() => readPkcs12(p12, "wrong"), /MAC could not be verified/);

  const unprotected = createTestPkcs12(seal.privateKey, [seal.der], "");
  const signature = crypto.sign(
    "sha256",
    Buffer.from("seal"),
    readPkcs12(unprotected, "").privateKey,
  );
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from("seal"),
      crypto.createPublicKey(seal.privateKey),
      signature,
    ),
    true,
  );
});

testCase(
  "refuses SHA-1, legacy encryption, clear keys and missing MACs",
  () => {
    const seal = createTestCertificate({ commonName: "PKCS#12 profile seal" });
    const cases = [
      ["sha1-mac", /Unsupported PKCS#12 MAC algorithm/],
      ["legacy-encryption", /Unsupported PKCS#12 encryption/],
      ["plain-key", /private key is not encrypted/],
      ["no-mac", /no integrity MAC/],
    ] as const;
    for (const [variant, error] of cases) {
      const p12 = createTestPkcs12(seal.privateKey, [seal.der], "pw", variant);
      assert.throws(() => readPkcs12(p12, "pw"), error);
    }
  },
);

void run();
