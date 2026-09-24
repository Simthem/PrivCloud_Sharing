import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveSigningIdentityProof } from "src/signing/signing-identity.util";
import {
  SigningWebAuthnService,
  buildSigningIntentHash,
} from "src/signing/signing-webauthn.service";
import {
  buildSignerContribution,
  buildSignerForensicRecord,
  buildSigningTransactionManifest,
  buildTransactionChallenge,
  canonicalJson,
  generateEvidenceId,
  hashSigningTransactionManifest,
  reconcileSignerContribution,
  sha256Hex,
  transactionChallengeBytes,
} from "src/signing/signing-evidence.util";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import * as forge from "node-forge";
import { SignedXml } from "xml-crypto";
import {
  evaluatePinnedTsa,
  listSignerIsAuthorized,
  parseTrustedList,
  verifyTrustedListSignature,
} from "src/signing/trusted-list.util";
import { collectRecipientFieldValues } from "src/signing/signing-field-values.util";
import {
  toVisibleAuditEvent,
  toVisibleRecipient,
} from "src/signing/signing-exposure.util";
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
  const account = (emailVerificationSource: string | null) => ({
    emailVerifiedAt: verifiedAt,
    emailVerificationSource,
    ldapDN: null,
    oAuthUsers: [],
  });
  assert.deepEqual(resolveSigningIdentityProof(account("EMAIL_LINK")), {
    method: "VERIFIED_EMAIL_ACCOUNT",
    verifiedAt,
  });
  assert.deepEqual(resolveSigningIdentityProof(account("ADMINISTRATOR")), {
    method: "ADMIN_VERIFIED_EMAIL_ACCOUNT",
    verifiedAt,
  });
  // An automatic exemption granted without SMTP proves nothing.
  assert.equal(resolveSigningIdentityProof(account(null)), null);
  assert.equal(
    resolveSigningIdentityProof({
      emailVerifiedAt: null,
      emailVerificationSource: null,
      ldapDN: null,
      oAuthUsers: [],
    }),
    null,
  );
});

testCase(
  "reconstructs the exact WebAuthn challenge from exported evidence",
  () => {
    const manifest = buildSigningTransactionManifest({
      action: "SIGN",
      documentId: baseManifest.documentId,
      recipientId: baseManifest.recipientId,
      signerAccountId: "user-42",
      sourceDocumentHash: baseManifest.sourceDocumentHash,
      expiresAt: baseManifest.expiresAt,
      signatureData: baseManifest.signatureData,
      signatureType: baseManifest.signatureType,
      fieldValues: baseManifest.fieldValues,
    });
    const hash = hashSigningTransactionManifest(manifest);
    const nonce = Buffer.alloc(32, 7).toString("base64url");
    assert.equal(
      buildTransactionChallenge(hash, nonce),
      buildTransactionChallenge(
        hashSigningTransactionManifest(JSON.parse(canonicalJson(manifest))),
        nonce,
      ),
    );
    assert.notEqual(
      buildTransactionChallenge(hash, nonce),
      buildTransactionChallenge(
        hash,
        Buffer.alloc(32, 8).toString("base64url"),
      ),
    );
  },
);

testCase("reconciles each signer of a multi-signer request separately", () => {
  const signerInput = (
    recipientId: string,
    signerAccountId: string,
    city: string,
  ) => {
    const fieldValues = [{ fieldId: `city-${recipientId}`, value: city }];
    const manifest = buildSigningTransactionManifest({
      action: "SIGN",
      documentId: "document-1",
      recipientId,
      signerAccountId,
      sourceDocumentHash: "a".repeat(64),
      expiresAt: null,
      signatureData: `signature-${recipientId}`,
      signatureType: "DRAW",
      fieldValues,
    });
    return {
      manifestJson: canonicalJson(manifest),
      signingIntentHash: hashSigningTransactionManifest(manifest),
      documentId: "document-1",
      recipientId,
      signerAccountId,
      sourceSha256: "a".repeat(64),
      contribution: buildSignerContribution({
        signatureType: "DRAW",
        signatureData: `signature-${recipientId}`,
        fieldValues,
      }),
    };
  };
  const alice = signerInput("alice", "user-1", "Paris");
  const bob = signerInput("bob", "user-2", "Lyon");
  assert.deepEqual(reconcileSignerContribution(alice), []);
  assert.deepEqual(reconcileSignerContribution(bob), []);
  assert.deepEqual(
    reconcileSignerContribution({ ...alice, contribution: bob.contribution }),
    [
      "the applied signature image differs from the signed one",
      "the applied field values differ from the signed ones",
    ],
  );
  assert.deepEqual(
    reconcileSignerContribution({ ...bob, sourceSha256: "b".repeat(64) }),
    ["the signer approved another source document"],
  );
  assert.deepEqual(
    reconcileSignerContribution({ ...bob, signerAccountId: "user-1" }),
    ["the signed manifest names another account"],
  );
});

testCase(
  "commits to the date the server fills in for an empty DATE field",
  () => {
    const rows = collectRecipientFieldValues(
      "alice",
      [
        {
          id: "date",
          type: "DATE",
          label: null,
          required: false,
          assignedRecipientId: null,
        },
        {
          id: "city",
          type: "TEXT",
          label: null,
          required: false,
          assignedRecipientId: "alice",
        },
        {
          id: "other",
          type: "TEXT",
          label: null,
          required: false,
          assignedRecipientId: "bob",
        },
      ],
      [{ fieldId: "city", value: "  Paris " }],
    );
    assert.deepEqual(
      rows.map(({ fieldId }) => fieldId),
      ["date", "city"],
    );
    assert.equal(rows[1].value, "Paris");
    assert.match(rows[0].value, /\d{4}$/);
  },
);

testCase(
  "keeps forensic data behind a random identifier and a salted hash",
  () => {
    const ids = new Set(Array.from({ length: 50 }, generateEvidenceId));
    assert.equal(ids.size, 50);
    for (const id of ids)
      assert.match(
        id,
        /^PCS-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/,
      );

    const input = {
      evidenceId: "PCS-0000-0000-0000-0000",
      documentId: "document-1",
      recipientId: "recipient-1",
      action: "SIGN" as const,
      actedAt: new Date("2026-09-23T09:00:00.000Z"),
      signer: {
        name: "Jean Dupont",
        email: "jean@example.com",
        role: "SIGNER",
        privcloudUserId: "user-1",
      },
      identity: {
        verificationMethod: "OIDC_ACCOUNT",
        verifiedAt: null,
        accountSnapshot: null,
      },
      network: { ipAddress: "203.0.113.7", userAgent: "Test" },
      evidence: {
        authenticationMethod: "EMAIL_OTP_CONSENT",
        signingIntentHash: "a".repeat(64),
        signedDocumentHash: "b".repeat(64),
      },
    };
    const first = buildSignerForensicRecord(input);
    const second = buildSignerForensicRecord(input);
    assert.equal(first.sha256, sha256Hex(first.record));
    // Same identity and IP, different salt: the published hash cannot be
    // recomputed from guessed identifiers.
    assert.notEqual(first.sha256, second.sha256);
    assert.equal(JSON.parse(first.record).network.ipAddress, "203.0.113.7");
  },
);

testCase(
  "never exposes forensic data or other signing links through the API",
  () => {
    const recipient = {
      id: "recipient-1",
      name: "Jean",
      email: "jean@example.com",
      role: "SIGNER",
      order: 1,
      status: "SIGNED",
      signedAt: new Date(),
      rejectionReason: null,
      signatureType: "DRAW",
      authenticationMethod: "WEBAUTHN",
      identityVerificationMethod: "OIDC_ACCOUNT",
      identityVerifiedAt: null,
      webauthnUserVerified: true,
      signedDocumentHash: "b".repeat(64),
      signingIntentHash: "a".repeat(64),
      evidenceId: "PCS-0000-0000-0000-0000",
      forensicRecordSha256: "c".repeat(64),
      signingToken: "secret-token",
      userId: "user-1",
      createdAt: new Date(),
      signingIp: "203.0.113.7",
      signingUserAgent: "Test",
      otpHash: "d".repeat(64),
      forensicRecord: "{}",
      webauthnSignature: "raw",
    };
    const forOther = toVisibleRecipient(recipient, {
      userId: "user-2",
      isRequester: false,
    });
    const serialized = JSON.stringify(forOther);
    for (const secret of [
      "secret-token",
      "203.0.113.7",
      "otpHash",
      'forensicRecord"',
      "raw",
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(forOther.isCurrentUser, false);
    const forRequester = toVisibleRecipient(recipient, {
      userId: "user-3",
      isRequester: true,
    });
    assert.equal(forRequester.signingToken, "secret-token");
    assert.equal(
      toVisibleRecipient(recipient, { userId: "user-1", isRequester: false })
        .isCurrentUser,
      true,
    );

    const event = toVisibleAuditEvent({
      id: "event-1",
      eventType: "SIGNED",
      actor: "jean@example.com",
      metadata: null,
      createdAt: new Date(),
      previousEventHash: null,
      eventHash: "e".repeat(64),
      ipAddress: "203.0.113.7",
      userAgent: "Test",
    } as any);
    assert.equal("ipAddress" in event, false);
    assert.equal("userAgent" in event, false);
  },
);

testCase("hands the ceremony the exact transaction challenge", async () => {
  const challenge = buildTransactionChallenge(
    "a".repeat(64),
    Buffer.alloc(32, 9).toString("base64url"),
  );
  const options = await generateAuthenticationOptions({
    rpID: "localhost",
    challenge: transactionChallengeBytes(challenge),
  });
  // clientDataJSON.challenge is this value: it must be the recomputable one.
  assert.equal(options.challenge, challenge);
});

testCase("confirms the pinned TSA only while it is a granted QTST", () => {
  const der = Buffer.from("pinned certificate");
  const pinned = createHash("sha256").update(der).digest("hex");
  const list = (status: string, nextUpdate: string) =>
    parseTrustedList(`<tsl:TrustServiceStatusList xmlns:tsl="http://uri.etsi.org/02231/v2#">
      <tsl:SchemeInformation><tsl:TSLSequenceNumber>42</tsl:TSLSequenceNumber>
      <tsl:NextUpdate><tsl:dateTime>${nextUpdate}</tsl:dateTime></tsl:NextUpdate></tsl:SchemeInformation>
      <tsl:TSPService><tsl:ServiceInformation>
        <tsl:ServiceTypeIdentifier>http://uri.etsi.org/TrstSvc/Svctype/TSA/QTST</tsl:ServiceTypeIdentifier>
        <tsl:ServiceName><tsl:Name xml:lang="en">Qualified TSA</tsl:Name></tsl:ServiceName>
        <tsl:ServiceDigitalIdentity><tsl:DigitalId><tsl:X509Certificate>${der.toString("base64")}</tsl:X509Certificate></tsl:DigitalId></tsl:ServiceDigitalIdentity>
        <tsl:ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/${status}</tsl:ServiceStatus>
        <tsl:StatusStartingTime>2020-01-01T00:00:00Z</tsl:StatusStartingTime>
      </tsl:ServiceInformation></tsl:TSPService></tsl:TrustServiceStatusList>`);
  const now = new Date("2026-09-23T00:00:00Z");
  const granted = list("granted", "2027-01-01T00:00:00Z");
  assert.equal(granted.sequenceNumber, "42");
  assert.equal(evaluatePinnedTsa(granted, [pinned], now).result, "OK");
  assert.equal(
    evaluatePinnedTsa(list("withdrawn", "2027-01-01T00:00:00Z"), [pinned], now)
      .result,
    "ALERT",
  );
  assert.equal(
    evaluatePinnedTsa(granted, ["0".repeat(64)], now).result,
    "ALERT",
  );
  assert.equal(
    evaluatePinnedTsa(list("granted", "2026-01-01T00:00:00Z"), [pinned], now)
      .result,
    "ALERT",
  );
  assert.equal(evaluatePinnedTsa(granted, [], now).result, "ALERT");
});

testCase("lets an account remove only its own signing passkeys", async () => {
  const calls: unknown[] = [];
  const prisma = {
    signingPasskey: {
      deleteMany: async (args: { where: { id?: string; userId: string } }) => {
        calls.push(args.where);
        return { count: args.where.userId === "owner" ? 1 : 0 };
      },
    },
  };
  const service = new SigningWebAuthnService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await service.deletePasskey("owner", "passkey-1");
  await assert.rejects(
    () => service.deletePasskey("someone-else", "passkey-1"),
    /Passkey not found/,
  );
  assert.deepEqual(calls, [
    { id: "passkey-1", userId: "owner" },
    { id: "passkey-1", userId: "someone-else" },
  ]);
});

testCase("reads a Trusted List only through its verified XML signature", () => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  certificate.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  const name = [{ name: "commonName", value: "Test Scheme Operator" }];
  certificate.setSubject(name);
  certificate.setIssuer(name);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const certificatePem = forge.pki.certificateToPem(certificate);
  const list =
    '<TrustServiceStatusList xmlns="http://uri.etsi.org/02231/v2#"><SchemeInformation>' +
    "<TSLSequenceNumber>7</TSLSequenceNumber><SchemeTerritory>FR</SchemeTerritory>" +
    "</SchemeInformation><TSPService><ServiceInformation>" +
    "<ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted</ServiceStatus>" +
    "</ServiceInformation></TSPService></TrustServiceStatusList>";
  const signer = new SignedXml({
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    publicCert: certificatePem,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });
  signer.addReference({
    xpath: "/*",
    isEmptyUri: true,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(list);
  const signedList = signer.getSignedXml();

  const verified = verifyTrustedListSignature(signedList);
  assert.equal(parseTrustedList(verified.signedXml).territory, "FR");
  assert.equal(parseTrustedList(verified.signedXml).sequenceNumber, "7");
  assert.throws(
    () => verifyTrustedListSignature(signedList.replace("granted", "withdrawn")),
    /invalid/,
  );
  assert.throws(() => verifyTrustedListSignature(list), /exactly one/);

  const pointers = [
    { territory: "FR", location: null, certificateSha256: [verified.signerSha256] },
  ];
  assert.equal(listSignerIsAuthorized(pointers, "FR", verified.signerSha256), true);
  assert.equal(listSignerIsAuthorized(pointers, "ES", verified.signerSha256), false);
  assert.equal(listSignerIsAuthorized(pointers, "FR", "0".repeat(64)), false);
});

testCase("returns a wrapped document key to its owner only", () => {
  const recipient = {
    id: "recipient-1",
    name: "Jean",
    email: "Jean@Example.com",
    role: "SIGNER",
    order: 1,
    status: "SIGNED",
    signedAt: new Date(),
    rejectionReason: null,
    signatureType: "DRAW",
    authenticationMethod: "EMAIL_OTP",
    identityVerificationMethod: null,
    identityVerifiedAt: null,
    webauthnUserVerified: null,
    signedDocumentHash: null,
    signingIntentHash: null,
    evidenceId: null,
    forensicRecordSha256: null,
    signingToken: "secret-token",
    userId: null,
    wrappedE2EKey: "wrapped-key",
    createdAt: new Date(),
  };
  const owner = toVisibleRecipient(recipient, {
    userId: "user-1",
    email: "jean@example.com",
    isRequester: false,
  });
  assert.equal(owner.isCurrentUser, true);
  assert.equal(owner.wrappedE2EKey, "wrapped-key");
  for (const viewer of [
    { userId: "user-2", email: "other@example.com", isRequester: false },
    { userId: "user-3", email: "requester@example.com", isRequester: true },
  ]) {
    const visible = toVisibleRecipient(recipient, viewer);
    assert.equal(visible.isCurrentUser, false);
    assert.equal(JSON.stringify(visible).includes("wrapped-key"), false);
  }
});

void run();
