import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SigningService } from "src/signing/signing.service";
import { assertSigningKeyEnvelope } from "src/signing/signing-key-envelope.util";
import { RecipientKeyEnvelopesDTO } from "src/signing/dto/recipient-key-envelopes.dto";
import { createUnitTestRunner } from "./unit-test";
import { sealToken } from "src/config/account-secrets";

const { testCase, run } = createUnitTestRunner(
  "signing recipient key delivery",
);
const envelope = () =>
  JSON.stringify({
    algorithm: "x25519-aes256gcm",
    ciphertext: randomBytes(128).toString("base64url"),
    ephemeralPublicKey: randomBytes(32).toString("base64url"),
    nonce: randomBytes(12).toString("base64url"),
    kemCiphertext: null,
  });
const account = (email = "signer@example.test") => ({
  id: randomUUID(),
  email,
  emailVerifiedAt: new Date() as Date | null,
  emailVerificationSource: "EMAIL_LINK" as string | null,
  ldapDN: null as string | null,
  oAuthUsers: [] as { provider: string }[],
});
function harness() {
  const signer = account(),
    other = account("other@example.test"),
    owner = randomUUID();
  const firstToken = randomUUID(),
    otherToken = randomUUID();
  const rows = [signer, other].map((user, i) => ({
    id: randomUUID(),
    email: user.email,
    name: "Signer",
    role: "SIGNER",
    order: 1,
    status: "PENDING",
    signedAt: null,
    userId: user.id,
    signingToken: sealToken("signing", i ? otherToken : firstToken),
    wrappedE2EKey: null,
    encryptedKeyEnvelope: null as string | null,
    keyEnvelopeUserId: null as string | null,
  }));
  const doc = {
    id: randomUUID(),
    creatorId: owner,
    fileId: randomUUID() as string | null,
    shareId: null,
    fileDeletedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 60000),
    isE2EEncrypted: true,
    status: "PENDING",
    recipients: rows,
    fields: [],
    auditTrail: [],
  };
  const writes: Prisma.SignatureRecipientUpdateManyArgs[] = [];
  const links: {
    userId: string;
    verifiedEmail: string;
    user: typeof signer;
  }[] = [];
  const service = new SigningService(
    {
      $queryRaw: async () => [signer, other].map(({ id }) => ({ id })),
      $transaction: async (operations: Promise<{ count: number }>[]) =>
        Promise.all(operations),
      user: {
        findUnique: async () => signer,
        findMany: async () => [signer, other],
      },
      oAuthUser: { findMany: async () => links },
      signatureDocument: {
        findFirst: async ({ where }: Prisma.SignatureDocumentFindFirstArgs) =>
          where.creatorId && where.creatorId !== owner ? null : doc,
        findMany: async () => [doc],
      },
      signatureRecipient: {
        updateMany: async (query: Prisma.SignatureRecipientUpdateManyArgs) => {
          writes.push(query);
          return { count: 1 };
        },
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return {
    service,
    signer,
    other,
    owner,
    doc,
    rows,
    writes,
    links,
    firstToken,
    otherToken,
  };
}

testCase(
  "a recorded mailbox proof permits delivery and no-SMTP exemptions do not",
  async () => {
    const h = harness();
    assert.deepEqual(
      await h.service.getRecipientEncryptionTargets([h.signer.email]),
      [{ email: h.signer.email, userId: h.signer.id }],
    );
    h.signer.emailVerificationSource = null;
    assert.deepEqual(
      await h.service.getRecipientEncryptionTargets([h.signer.email]),
      [],
    );
    h.signer.emailVerifiedAt = null;
    h.signer.oAuthUsers.push({ provider: "github" });
    assert.deepEqual(
      await h.service.getRecipientEncryptionTargets([h.signer.email]),
      [],
    );
  },
);

testCase(
  "only the exact provider-vouched address can receive an automatic envelope",
  async () => {
    const h = harness();
    h.signer.emailVerificationSource = null;
    h.signer.emailVerifiedAt = null;
    h.links.push({
      userId: h.signer.id,
      verifiedEmail: h.signer.email,
      user: h.signer,
    });
    assert.deepEqual(
      await h.service.getRecipientEncryptionTargets([h.signer.email]),
      [{ email: h.signer.email, userId: h.signer.id }],
    );
    h.links[0].verifiedEmail = "unrelated@example.test";
    assert.deepEqual(
      await h.service.getRecipientEncryptionTargets([h.signer.email]),
      [],
    );
  },
);

testCase(
  "only the requester can prepare or write envelopes for an existing request",
  async () => {
    const h = harness();
    const targets = await h.service.getDocumentEncryptionTargets(
      h.doc.id,
      h.owner,
    );
    assert.equal(targets.length, 2);
    await assert.rejects(
      h.service.getDocumentEncryptionTargets(h.doc.id, h.signer.id),
      /Document not found/,
    );
    await assert.rejects(
      h.service.storeRecipientKeyEnvelopes(h.doc.id, h.signer.id, {
        recipients: [
          {
            recipientId: h.rows[0].id,
            userId: h.signer.id,
            encryptedKeyEnvelope: envelope(),
          },
        ],
      }),
      /Document not found/,
    );
    assert.equal(h.writes.length, 0);
  },
);

testCase(
  "the server stores opaque data with account binding and lifecycle compare-and-set guards",
  async () => {
    const h = harness(),
      encrypted = envelope();
    assert.deepEqual(
      await h.service.storeRecipientKeyEnvelopes(h.doc.id, h.owner, {
        recipients: [
          {
            recipientId: h.rows[0].id,
            userId: h.signer.id,
            encryptedKeyEnvelope: encrypted,
          },
        ],
      }),
      { stored: 1 },
    );
    assert.deepEqual(h.writes[0].data, {
      encryptedKeyEnvelope: encrypted,
      keyEnvelopeUserId: h.signer.id,
      userId: h.signer.id,
    });
    assert.equal(h.writes[0].where.encryptedKeyEnvelope, null);
    assert.equal(h.writes[0].where.documentId, h.doc.id);
    assert.deepEqual(h.writes[0].where.OR, [
      { userId: h.signer.id },
      { userId: null },
    ]);
    assert.ok(h.writes[0].where.document);
  },
);

testCase(
  "a changed account binding or duplicate target cannot grant another account access",
  async () => {
    const h = harness(),
      entry = {
        recipientId: h.rows[0].id,
        userId: h.other.id,
        encryptedKeyEnvelope: envelope(),
      };
    await assert.rejects(
      h.service.storeRecipientKeyEnvelopes(h.doc.id, h.owner, {
        recipients: [entry],
      }),
      /binding changed/,
    );
    entry.userId = h.signer.id;
    await assert.rejects(
      h.service.storeRecipientKeyEnvelopes(h.doc.id, h.owner, {
        recipients: [entry, entry],
      }),
      /binding changed/,
    );
    h.rows[0].userId = h.other.id;
    await assert.rejects(
      h.service.storeRecipientKeyEnvelopes(h.doc.id, h.owner, {
        recipients: [entry],
      }),
      /binding changed/,
    );
    assert.equal(h.writes.length, 0);
  },
);

testCase(
  "grant preparation excludes finished, expired, deleted, CC and already provisioned requests",
  async () => {
    for (const status of ["COMPLETED", "CANCELLED", "REJECTED"]) {
      const h = harness();
      h.doc.status = status;
      assert.deepEqual(
        await h.service.getDocumentEncryptionTargets(h.doc.id, h.owner),
        [],
      );
    }
    const expired = harness();
    expired.doc.expiresAt = new Date(0);
    assert.deepEqual(
      await expired.service.getDocumentEncryptionTargets(
        expired.doc.id,
        expired.owner,
      ),
      [],
    );
    const deleted = harness();
    deleted.doc.fileId = null;
    await assert.rejects(
      deleted.service.getDocumentEncryptionTargets(
        deleted.doc.id,
        deleted.owner,
      ),
      /source file was deleted/,
    );
    const h = harness();
    h.rows[0].role = "CC";
    h.rows[1].encryptedKeyEnvelope = envelope();
    assert.deepEqual(
      await h.service.getDocumentEncryptionTargets(h.doc.id, h.owner),
      [],
    );
  },
);

testCase(
  "list and detail deliver only the current account's key envelope",
  async () => {
    const h = harness();
    h.rows[0].encryptedKeyEnvelope = envelope();
    h.rows[0].keyEnvelopeUserId = h.signer.id;
    h.rows[1].encryptedKeyEnvelope = envelope();
    h.rows[1].keyEnvelopeUserId = h.other.id;
    const list = await h.service.getReceivedDocuments(h.signer.id);
    assert.equal(
      list[0].signingAction?.keyEnvelope?.ciphertext,
      h.rows[0].encryptedKeyEnvelope,
    );
    assert.equal(
      JSON.stringify(list).includes(h.rows[1].encryptedKeyEnvelope),
      false,
    );
    const detail = await h.service.getDocument(h.doc.id, h.signer.id);
    assert.equal(
      detail.recipients[0].encryptedKeyEnvelope,
      h.rows[0].encryptedKeyEnvelope,
    );
    assert.equal(
      JSON.stringify(detail).includes(h.rows[1].encryptedKeyEnvelope),
      false,
    );
    h.rows[0].keyEnvelopeUserId = h.other.id;
    const wrongOwner = await h.service.getDocument(h.doc.id, h.signer.id);
    assert.equal(wrongOwner.recipients[0].encryptedKeyEnvelope, undefined);
    assert.equal(wrongOwner.signingAction?.keyEnvelope, undefined);
  },
);

testCase(
  "plaintext keys, malformed crypto envelopes and invalid batch shapes are rejected",
  async () => {
    for (const value of [
      randomBytes(32).toString("base64url"),
      "null",
      "[]",
      JSON.stringify({
        ...JSON.parse(envelope()),
        key: randomBytes(32).toString("base64url"),
      }),
      JSON.stringify({ ...JSON.parse(envelope()), nonce: "short" }),
    ]) {
      assert.throws(
        () => assertSigningKeyEnvelope(value),
        /Invalid encrypted signing key envelope/,
      );
    }
    assert.doesNotThrow(() => assertSigningKeyEnvelope(envelope()));
    for (const recipients of [
      [],
      Array.from({ length: 51 }, () => ({
        recipientId: randomUUID(),
        userId: randomUUID(),
        encryptedKeyEnvelope: envelope(),
      })),
      [
        {
          recipientId: "wrong",
          userId: randomUUID(),
          encryptedKeyEnvelope: 42,
        },
      ],
    ]) {
      assert.ok(
        (
          await validate(
            plainToInstance(RecipientKeyEnvelopesDTO, { recipients }),
          )
        ).length > 0,
      );
    }
  },
);

void run();
