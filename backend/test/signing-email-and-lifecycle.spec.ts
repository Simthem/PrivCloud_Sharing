import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ForbiddenException } from "@nestjs/common";
import { SigningDownloadService } from "src/signing/signing-download.service";
import { SigningService } from "src/signing/signing.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "signing email verification and lifecycle",
);

const createOtpHarness = () => {
  const sentEmails: Array<{ email: string; subject: string; body: string }> =
    [];
  const recipient: any = {
    id: "recipient-1",
    documentId: "document-1",
    email: "signer@example.test",
    name: "Signer",
    role: "SIGNER",
    status: "VIEWED",
    otpHash: null,
    otpSentAt: null,
    otpVerified: false,
    otpFailures: 0,
    identityVerificationMethod: "NONE",
    identityVerifiedAt: null,
    document: {
      id: "document-1",
      fileName: "contract.pdf",
      status: "PENDING",
      signatureLevel: "STANDARD",
      expiresAt: new Date(Date.now() + 60_000),
    },
  };

  const matchesWhere = (where: any) => {
    if (where.id && where.id !== recipient.id) return false;
    if (
      typeof where.otpVerified === "boolean" &&
      where.otpVerified !== recipient.otpVerified
    ) {
      return false;
    }
    if (
      typeof where.otpHash === "string" &&
      where.otpHash !== recipient.otpHash
    ) {
      return false;
    }
    if (where.OR) {
      const allowed = where.OR.some((condition: any) => {
        if (condition.otpSentAt === null) return recipient.otpSentAt === null;
        if (condition.otpSentAt?.lt) {
          return Boolean(
            recipient.otpSentAt && recipient.otpSentAt < condition.otpSentAt.lt,
          );
        }
        return false;
      });
      if (!allowed) return false;
    }
    return true;
  };

  const prisma = {
    signatureRecipient: {
      findUnique: async () => recipient,
      updateMany: async ({ where, data }: any) => {
        if (!matchesWhere(where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            recipient[key] += (value as { increment: number }).increment;
          } else {
            recipient[key] = value;
          }
        }
        return { count: 1 };
      },
    },
  };
  const service = new SigningService(
    prisma as never,
    {
      sendMail: async (email: string, subject: string, body: string) => {
        sentEmails.push({ email, subject, body });
      },
    } as never,
    {} as never,
    { get: () => "unit-test-signing-secret" } as never,
    {} as never,
    {} as never,
    { notifyTeamMembers: async () => [] } as never,
  ) as any;
  service.createAuditEvent = async () => undefined;

  return { recipient, sentEmails, service };
};

testCase(
  "sends no clear OTP in the API response and verifies mailbox control",
  async () => {
    const { recipient, sentEmails, service } = createOtpHarness();

    const response = await service.sendSigningEmailOtp("token-1");
    assert.deepEqual(response, {
      verified: false,
      sent: true,
      expiresInSeconds: 600,
    });
    assert.equal(sentEmails.length, 1);
    const code = sentEmails[0].body.match(/: (\d{6})/)?.[1];
    assert.match(code || "", /^\d{6}$/);
    assert.match(recipient.otpHash, /^[a-f0-9]{64}$/);
    assert.notEqual(recipient.otpHash, code);

    await assert.rejects(
      () =>
        service.verifySigningEmailOtp("token-1", "999999", "127.0.0.1", "test"),
      /Invalid verification code/,
    );
    assert.equal(recipient.otpFailures, 1);

    assert.deepEqual(
      await service.verifySigningEmailOtp("token-1", code, "127.0.0.1", "test"),
      { verified: true },
    );
    assert.equal(recipient.otpVerified, true);
    assert.equal(recipient.identityVerificationMethod, "EMAIL_OTP");
    assert.ok(recipient.identityVerifiedAt instanceof Date);
    assert.equal(recipient.otpHash, null);
  },
);

testCase("refuses a second OTP during the per-recipient cooldown", async () => {
  const { service } = createOtpHarness();
  await service.sendSigningEmailOtp("token-1");
  await assert.rejects(
    () => service.sendSigningEmailOtp("token-1"),
    /wait before requesting another verification code/,
  );
});

testCase(
  "blocks standard signature and rejection without verified email",
  async () => {
    const { recipient, service } = createOtpHarness();
    recipient.document.originalFileKey = "share-1/file-1";
    recipient.document.isE2EEncrypted = false;
    recipient.document.recipients = [recipient];
    recipient.document.fields = [];
    recipient.document.creator = null;
    recipient.order = 1;

    await assert.rejects(
      () =>
        service.signDocument(
          "token-1",
          { signatureData: "signature", signatureType: "TYPE" },
          "127.0.0.1",
          "test",
        ),
      (error: unknown) => error instanceof ForbiddenException,
    );
    await assert.rejects(
      () => service.rejectDocument("token-1", {}, "127.0.0.1", "test"),
      (error: unknown) => error instanceof ForbiddenException,
    );
  },
);

testCase(
  "blocks standard PDF preview until email control is verified",
  async () => {
    let fileRead = false;
    const service = new SigningDownloadService(
      {
        signatureRecipient: {
          findUnique: async () => ({
            userId: null,
            otpVerified: false,
            document: {
              status: "PENDING",
              expiresAt: null,
              signatureLevel: "STANDARD",
              originalFileKey: "share-1/file-1",
              fileName: "contract.pdf",
            },
          }),
        },
      } as never,
      {
        getFileByKey: async () => {
          fileRead = true;
          return Buffer.alloc(0);
        },
      } as never,
    );

    await assert.rejects(
      () => service.getOriginalPdfForPreview("token-1"),
      (error: unknown) => error instanceof ForbiddenException,
    );
    assert.equal(fileRead, false);
  },
);

testCase(
  "invalidates public actions when the source is tombstoned",
  async () => {
    const { recipient, sentEmails, service } = createOtpHarness();
    recipient.document.fileId = null;
    recipient.document.fileDeletedAt = new Date();

    await assert.rejects(
      () => service.sendSigningEmailOtp("token-1"),
      /source file was deleted/,
    );
    assert.equal(sentEmails.length, 0);
  },
);

testCase("keeps a tombstoned request in the owner audit listing", async () => {
  const tombstone = {
    id: "document-1",
    fileId: null,
    fileDeletedAt: new Date(),
    recipients: [],
  };
  const service = new SigningService(
    {
      signatureDocument: { findMany: async () => [tombstone] },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { notifyTeamMembers: async () => [] } as never,
  );

  const documents = await service.getMyDocuments("owner-1");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, tombstone.id);
  assert.equal(documents[0].fileDeleted, true);
});

testCase(
  "routes encrypted team signature notifications only to their action owner",
  async () => {
    const notifications: Array<{ userId: string; type: string }> = [];
    const activeMemberIds = new Set(["member-a", "member-b", "member-c"]);
    const service = new SigningService(
      {
        teamMember: {
          findMany: async ({ where }: any) =>
            where.userId.in
              .filter((userId: string) => activeMemberIds.has(userId))
              .map((userId: string) => ({ userId })),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        notify: async (params: { userId: string; type: string }) => {
          notifications.push(params);
        },
      } as never,
    ) as any;

    service.notifyTeamOfSignatureInvitation(
      {
        id: "document-1",
        teamId: "team-1",
        creatorId: "member-a",
      },
      [
        {
          id: "recipient-b",
          userId: "member-b",
          teamInviteNotification: "encrypted-b",
        },
      ],
      "member-a",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      notifications.map((notification) => notification.userId),
      ["member-b"],
    );

    notifications.length = 0;
    service.notifyTeamOfSignature(
      {
        id: "document-1",
        teamId: "team-1",
        creatorId: "member-a",
      },
      { id: "recipient-b", teamProgressNotification: "encrypted-a" },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      notifications.map((notification) => notification.userId),
      ["member-a"],
    );

    notifications.length = 0;
    service.notifyTeamOfSignatureCompletion({
      id: "document-2",
      teamId: "team-1",
      creatorId: "member-a",
      recipients: [
        {
          id: "recipient-b",
          userId: "member-b",
          teamCompletionNotification: "encrypted-b",
        },
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      notifications.map((notification) => notification.userId),
      ["member-b"],
    );
  },
);

testCase(
  "invalidates deleted sources while retaining their audit requests",
  () => {
    const schema = fs.readFileSync(
      path.resolve("prisma/schema.prisma"),
      "utf8",
    );
    const migration = fs.readFileSync(
      path.resolve(
        "prisma/migrations/20260904160000_add_oss_signing_evidence/migration.sql",
      ),
      "utf8",
    );

    assert.match(schema, /fileId\s+String\?/);
    assert.match(schema, /fileDeletedAt\s+DateTime\?/);
    assert.match(
      schema,
      /file\s+File\?\s+@relation\(fields: \[fileId\], references: \[id\], onDelete: SetNull\)/,
    );
    assert.doesNotMatch(migration, /DELETE FROM "SignatureDocument"/);
    assert.match(migration, /File_mark_signature_source_deleted/);
    assert.match(migration, /ON DELETE SET NULL ON UPDATE CASCADE/);
    assert.match(migration, /"fileId" TEXT,/);
  },
);

testCase(
  "keeps legal evidence and the five client steps level-specific",
  () => {
    const certificateSource = fs.readFileSync(
      path.resolve("src/signing/pdf-signing.service.ts"),
      "utf8",
    );
    const signingServiceSource = fs.readFileSync(
      path.resolve("src/signing/signing.service.ts"),
      "utf8",
    );
    const signingPageSource = fs.readFileSync(
      path.resolve("../frontend/src/pages/sign/[token].tsx"),
      "utf8",
    );

    assert.match(
      certificateSource,
      /const levelSpecificLegalText = isReinforced/,
    );
    assert.match(
      certificateSource,
      /code à usage unique envoyé à l'adresse e-mail/,
    );
    assert.match(
      certificateSource,
      /compte PrivCloud attribué au destinataire/,
    );
    assert.doesNotMatch(
      certificateSource,
      /Workflow de signature avancée aligné eIDAS/,
    );
    assert.match(
      signingServiceSource,
      /Standard \(code e-mail \+ consentement\)/,
    );
    assert.doesNotMatch(
      signingServiceSource,
      /Standard \(consentement par lien\)/,
    );
    assert.equal((signingPageSource.match(/<Stepper\.Step/g) || []).length, 5);
    assert.match(signingPageSource, /signing\.sign\.steps\.invitation/);
    assert.match(signingPageSource, /signing\.sign\.steps\.review/);
    assert.match(
      signingPageSource,
      /isReinforced\s*\? "signing\.sign\.steps\.secure"\s*: "signing\.sign\.steps\.email"/,
    );
    assert.match(signingPageSource, /signing\.sign\.legal\.standard/);
    assert.match(signingPageSource, /signing\.sign\.legal\.reinforced/);
  },
);

void run();
