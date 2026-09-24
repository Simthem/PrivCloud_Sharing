import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalJson,
  reconcileSignerContributions,
} from "../src/utils/signingReconciliation.util.ts";

const sha256Hex = async (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const SOURCE = "a".repeat(64);

const signer = (id, userId, signatureData, fieldValues) => {
  const manifest = {
    protocol: "privcloud-signing-transaction-v2",
    action: "SIGN",
    documentId: "doc-1",
    recipientId: id,
    signerAccountId: userId,
    documentSha256: SOURCE,
    storageObjectSha256: null,
    requestExpiresAt: null,
    signatureType: "DRAW",
    signatureDataSha256: hash(signatureData),
    fieldValues,
    rejectionReason: null,
    consent: { version: "v1", text: "ok", textSha256: hash("ok") },
  };
  const manifestJson = canonicalJson(manifest);
  return {
    id,
    name: id,
    userId,
    signatureType: "DRAW",
    signatureData,
    signingIntentHash: hash(manifestJson),
    webauthnTransactionManifest: manifestJson,
  };
};

const signers = [
  signer("alice", "user-a", "data:image/png;base64,AAA", [
    { fieldId: "f1", value: "Paris" },
  ]),
  signer("bob", "user-b", "data:image/png;base64,BBB", []),
];
const fieldValues = [{ fieldId: "f1", recipientId: "alice", value: "Paris" }];

test("accepts every signer contribution approved with WebAuthn", async () => {
  const problems = await reconcileSignerContributions({
    documentId: "doc-1",
    sourceSha256: SOURCE,
    signers,
    fieldValues,
    sha256Hex,
  });
  assert.deepEqual(problems, []);
});

test("rejects a source that one signer did not approve", async () => {
  const problems = await reconcileSignerContributions({
    documentId: "doc-1",
    sourceSha256: "b".repeat(64),
    signers,
    fieldValues,
    sha256Hex,
  });
  assert.equal(problems.length, 2);
});

test("rejects a swapped signature image or a changed field value", async () => {
  const problems = await reconcileSignerContributions({
    documentId: "doc-1",
    sourceSha256: SOURCE,
    signers: [
      { ...signers[0], signatureData: signers[1].signatureData },
      signers[1],
    ],
    fieldValues: [{ fieldId: "f1", recipientId: "alice", value: "Lyon" }],
    sha256Hex,
  });
  assert.deepEqual(problems, [
    "alice: the applied signature image differs from the signed one",
    "alice: the applied field values differ from the signed ones",
  ]);
});
