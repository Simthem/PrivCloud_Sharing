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

type FakeDocument = {
  id: string;
  fileName: string;
  status: string;
  signatureLevel: string;
  expiresAt: Date;
  [field: string]: unknown;
};

type FakeRecipient = {
  id: string;
  status: string;
  otpHash: string | null;
  otpSentAt: Date | null;
  otpVerified: boolean;
  otpFailures: number;
  otpSessionHash: string | null;
  otpSessionExpiresAt: Date | null;
  identityVerificationMethod: string;
  identityVerifiedAt: Date | null;
  document: FakeDocument;
  [field: string]: unknown;
};

type RecipientWhere = {
  id?: string;
  otpVerified?: boolean;
  otpHash?: string | null;
  OR?: Array<{ otpSentAt?: null | { lt: Date } }>;
};

const createOtpHarness = () => {
  const sentEmails: Array<{ email: string; subject: string; body: string }> =
    [];
  const recipient: FakeRecipient = {
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
    otpSessionHash: null,
    otpSessionExpiresAt: null,
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

  const matchesWhere = (where: RecipientWhere) => {
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
      const allowed = where.OR.some((condition) => {
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
      updateMany: async ({
        where,
        data,
      }: {
        where: RecipientWhere;
        data: Record<string, unknown>;
      }) => {
        if (!matchesWhere(where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            recipient[key] =
              (recipient[key] as number) +
              (value as { increment: number }).increment;
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
      sendSigningMail: async (email: string, subject: string, body: string) => {
        sentEmails.push({ email, subject, body });
      },
    } as never,
    {} as never,
    { get: () => "unit-test-signing-secret" } as never,
    {} as never,
    {} as never,
    {} as never,
    { notifyTeamMembers: async () => [] } as never,
  );
  // The audit chain is covered elsewhere. Here it records nothing.
  Object.assign(service, { createAuditEvent: async () => undefined });

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

    const verified = await service.verifySigningEmailOtp(
      "token-1",
      code,
      "127.0.0.1",
      "test",
    );
    assert.equal(verified.verified, true);
    assert.match(verified.session, /^[A-Za-z0-9_-]{43}$/);
    assert.match(recipient.otpSessionHash, /^[a-f0-9]{64}$/);
    assert.notEqual(recipient.otpSessionHash, verified.session);
    assert.equal(recipient.otpVerified, true);
    assert.equal(recipient.identityVerificationMethod, "EMAIL_OTP");
    assert.ok(recipient.identityVerifiedAt instanceof Date);
    assert.equal(recipient.otpHash, null);
  },
);

/** Sends a code and returns it, as read from the recipient's mailbox. */
const mailedCode = async (
  harness: ReturnType<typeof createOtpHarness>,
  session?: string,
) => {
  harness.recipient.otpSentAt = null;
  await harness.service.sendSigningEmailOtp("token-1", session);
  const body = harness.sentEmails[harness.sentEmails.length - 1].body;
  return body.match(/: (\d{6})/)?.[1] as string;
};

const prepareSigning = (recipient: FakeRecipient) => {
  recipient.document.originalFileKey = "share-1/file-1";
  recipient.document.isE2EEncrypted = false;
  recipient.document.recipients = [recipient];
  recipient.document.fields = [];
  recipient.document.creator = null;
  recipient.order = 1;
};

testCase(
  "binds a verified address to the browser that typed the code",
  async () => {
    const harness = createOtpHarness();
    const { recipient, service } = harness;
    prepareSigning(recipient);
    const code = await mailedCode(harness);
    const { session } = await service.verifySigningEmailOtp(
      "token-1",
      code,
      "127.0.0.1",
      "test",
    );

    // That browser sees the document, any other holder of the link does not.
    const mine = await service.getSigningPage("token-1", session);
    assert.equal(mine.recipient.emailVerified, true);
    const theirs = await service.getSigningPage("token-1", "x".repeat(43));
    assert.equal(theirs.recipient.emailVerified, false);
    assert.equal(
      (await service.getSigningPage("token-1")).recipient.emailVerified,
      false,
    );
    assert.deepEqual(await service.sendSigningEmailOtp("token-1", session), {
      verified: true,
      sent: false,
    });

    // Signing or rejecting from elsewhere is refused before anything else.
    for (const other of [undefined, "x".repeat(43), session.slice(1)]) {
      await assert.rejects(
        () =>
          service.signDocument(
            "token-1",
            { signatureData: "signature", signatureType: "TYPE" },
            "127.0.0.1",
            "test",
            other,
          ),
        /Verify the assigned email address/,
      );
      await assert.rejects(
        () => service.rejectDocument("token-1", {}, "127.0.0.1", "test", other),
        /Verify the assigned email address/,
      );
    }
  },
);

testCase(
  "another holder of the link proves the mailbox again, on its own",
  async () => {
    const harness = createOtpHarness();
    const { recipient, service } = harness;
    prepareSigning(recipient);
    const first = await service.verifySigningEmailOtp(
      "token-1",
      await mailedCode(harness),
      "127.0.0.1",
      "test",
    );

    // A second browser gets a code of its own, mailed to the same address.
    const code = await mailedCode(harness);
    assert.equal(harness.sentEmails.length, 2);
    // Its guesses still count while the address is verified elsewhere.
    await assert.rejects(() =>
      service.verifySigningEmailOtp("token-1", "000000", "10.0.0.2", "b"),
    );
    assert.equal(recipient.otpFailures, 1);
    const second = await service.verifySigningEmailOtp(
      "token-1",
      code,
      "10.0.0.2",
      "b",
    );
    assert.notEqual(second.session, first.session);
    // The latest verification wins: the earlier browser starts again.
    assert.equal(
      (await service.getSigningPage("token-1", first.session)).recipient
        .emailVerified,
      false,
    );
    assert.equal(
      (await service.getSigningPage("token-1", second.session)).recipient
        .emailVerified,
      true,
    );
  },
);

testCase("one code verifies one browser, even when two race", async () => {
  const harness = createOtpHarness();
  const code = await mailedCode(harness);
  const results = await Promise.allSettled([
    harness.service.verifySigningEmailOtp("token-1", code, "a", "a"),
    harness.service.verifySigningEmailOtp("token-1", code, "b", "b"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

testCase(
  "an address verified before browsers were bound is verified again",
  async () => {
    const harness = createOtpHarness();
    const { recipient, service } = harness;
    prepareSigning(recipient);
    recipient.otpVerified = true;
    recipient.identityVerificationMethod = "EMAIL_OTP";
    recipient.identityVerifiedAt = new Date();
    const page = await service.getSigningPage("token-1");
    assert.equal(page.recipient.emailVerified, false);
    const response = await service.sendSigningEmailOtp("token-1");
    assert.equal(response.sent, true);
  },
);

testCase("an expired signing session is refused", async () => {
  const harness = createOtpHarness();
  const { recipient, service } = harness;
  prepareSigning(recipient);
  const { session } = await service.verifySigningEmailOtp(
    "token-1",
    await mailedCode(harness),
    "127.0.0.1",
    "test",
  );
  recipient.otpSessionExpiresAt = new Date(Date.now() - 1_000);
  assert.equal(
    (await service.getSigningPage("token-1", session)).recipient.emailVerified,
    false,
  );
});

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

testCase(
  "keeps a signer's link to a completed request after source deletion",
  async () => {
    const { recipient, service } = createOtpHarness();
    recipient.status = "SIGNED";
    recipient.document.status = "COMPLETED";
    recipient.document.fileId = null;
    recipient.document.fileDeletedAt = new Date();
    recipient.document.expiresAt = new Date(Date.now() - 60_000);
    recipient.document.fields = [];
    recipient.document.creator = null;

    const page = await service.getSigningPage("token-1");
    assert.equal(page.alreadySigned, true);
    assert.equal(page.documentStatus, "COMPLETED");
    assert.deepEqual(page.fields, []);
  },
);

testCase(
  "still closes every other link once the source is deleted",
  async () => {
    const { recipient, service } = createOtpHarness();
    recipient.document.fileId = null;
    recipient.document.fileDeletedAt = new Date();
    recipient.document.fields = [];
    recipient.document.creator = null;

    recipient.status = "SIGNED";
    recipient.document.status = "PARTIAL";
    await assert.rejects(
      () => service.getSigningPage("token-1"),
      /source file was deleted/,
    );

    recipient.status = "VIEWED";
    recipient.document.status = "COMPLETED";
    await assert.rejects(
      () => service.getSigningPage("token-1"),
      /source file was deleted/,
    );
  },
);

testCase(
  "a failed finalization keeps the signature and tells the creator",
  async () => {
    const statuses: string[] = [];
    const mails: Array<{ to: string; body: string }> = [];
    const service = new SigningService(
      {
        signatureDocument: {
          findUnique: async ({ select }: { select?: unknown }) =>
            select
              ? { status: "PENDING" }
              : {
                  id: "document-1",
                  originalFileKey: "signing/original.pdf",
                  creatorId: "owner-1",
                  fileName: "agreement.pdf",
                  recipients: [],
                  fields: [],
                },
          update: async ({ data }: { data: { status: string } }) => {
            statuses.push(data.status);
          },
        },
        user: {
          findUnique: async () => ({
            email: "owner@example.test",
            username: "owner",
          }),
        },
      } as never,
      {
        sendSigningMail: async (to: string, _subject: string, body: string) => {
          mails.push({ to, body });
        },
      } as never,
      {
        getFileByKey: async () => {
          throw new Error("storage unavailable");
        },
      } as never,
      {
        get: (key: string) =>
          key === "general.appUrl" ? "https://app.test" : undefined,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as { finalizeDocument: (id: string) => Promise<void> };
    Object.assign(service, {
      logger: { log: () => undefined, error: () => undefined },
      createAuditEvent: async () => undefined,
    });

    await service.finalizeDocument("document-1");
    assert.deepEqual(statuses, ["AWAITING_FINALIZATION"]);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "owner@example.test");
    assert.match(mails[0].body, /https:\/\/app\.test\/signing\/document-1/);
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
          findMany: async ({
            where,
          }: {
            where: { userId: { in: string[] } };
          }) =>
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
      {} as never,
      {
        notify: async (params: { userId: string; type: string }) => {
          notifications.push(params);
        },
      } as never,
    ) as unknown as {
      notifyTeamOfSignatureInvitation: (...args: unknown[]) => void;
      notifyTeamOfSignature: (...args: unknown[]) => void;
      notifyTeamOfSignatureCompletion: (...args: unknown[]) => void;
    };

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
        {
          id: "recipient-b-duplicate",
          userId: "member-b",
          teamCompletionNotification: "encrypted-b-2",
        },
        {
          id: "recipient-a",
          userId: "member-a",
          teamCompletionNotification: "encrypted-a",
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
      /met en œuvre une signature électronique avancée conformément aux/,
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
