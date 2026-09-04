import "reflect-metadata";
import assert from "node:assert/strict";
import { resolveSigningIdentityProof } from "src/signing/signing-identity.util";
import { buildSigningIntentHash } from "src/signing/signing-webauthn.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing evidence");

const baseManifest = {
  purpose: "SIGN" as const,
  documentId: "document-1",
  recipientId: "recipient-1",
  sourceDocumentHash: "a".repeat(64),
  expiresAt: new Date("2026-09-03T12:00:00.000Z"),
  signatureData: "data:image/png;base64,signature",
  signatureType: "DRAW",
  fieldValues: [
    { fieldId: "field-b", value: "second" },
    { fieldId: "field-a", value: "first" },
  ],
};

testCase("creates a deterministic intent independently of field order", () => {
  const left = buildSigningIntentHash(baseManifest);
  const right = buildSigningIntentHash({
    ...baseManifest,
    fieldValues: [...baseManifest.fieldValues].reverse(),
  });
  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
});

testCase(
  "binds the intent to the document, action and submitted content",
  () => {
    const reference = buildSigningIntentHash(baseManifest);
    assert.notEqual(
      reference,
      buildSigningIntentHash({
        ...baseManifest,
        sourceDocumentHash: "b".repeat(64),
      }),
    );
    assert.notEqual(
      reference,
      buildSigningIntentHash({ ...baseManifest, signatureData: "changed" }),
    );
    assert.notEqual(
      reference,
      buildSigningIntentHash({
        purpose: "REJECT",
        documentId: baseManifest.documentId,
        recipientId: baseManifest.recipientId,
        sourceDocumentHash: baseManifest.sourceDocumentHash,
        expiresAt: baseManifest.expiresAt,
        reason: "refused",
      }),
    );
  },
);

testCase("describes account assurance without claiming civil identity", () => {
  const verifiedAt = new Date("2026-09-01T09:00:00.000Z");
  assert.deepEqual(
    resolveSigningIdentityProof({
      emailVerifiedAt: verifiedAt,
      ldapDN: null,
      oAuthUsers: [],
    }),
    { method: "VERIFIED_EMAIL_ACCOUNT", verifiedAt },
  );
  assert.equal(
    resolveSigningIdentityProof({
      emailVerifiedAt: null,
      ldapDN: null,
      oAuthUsers: [],
    }),
    null,
  );
});

void run();
