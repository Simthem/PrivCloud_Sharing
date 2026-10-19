import "reflect-metadata";
import assert from "node:assert/strict";
import { EmailService } from "src/email/email.service";
import { ShareService } from "src/share/share.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("reverse share key privacy");

const RS_KEY = "reverse-share-key-must-stay-in-the-browser";

const silentLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
};

function reverseShareUpload() {
  return {
    id: "uploaded-through-reverse-share",
    name: null,
    description: null,
    expiration: new Date(Date.now() + 86_400_000),
    uploadLocked: false,
    uploadLastActivityAt: new Date(),
    uploadCleanupStartedAt: null,
    isE2EEncrypted: true,
    creatorId: null,
    creator: null,
    teamFileRequestId: null,
    teamFolderId: null,
    files: [{ id: "file-1", name: "file", size: "42", relativePath: null }],
    recipients: [{ email: "recipient@example.test" }],
    reverseShare: {
      creatorId: "owner-1",
      shareExpiration: new Date(0),
      sendEmailNotification: true,
      creator: { id: "owner-1", email: "owner@example.test" },
    },
    teamFolder: null,
  };
}

testCase("never forwards a key sent with a reverse share upload", async () => {
  const share = reverseShareUpload();
  const mailed: unknown[][] = [];
  const transactionClient = {
    share: {
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ ...share, uploadLocked: true }),
    },
    reverseShare: { updateMany: async () => ({ count: 1 }) },
    shareQuotaEvent: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma = {
    share: { findUnique: async () => share },
    $transaction: async (
      callback: (tx: typeof transactionClient) => Promise<unknown>,
    ) => callback(transactionClient),
  };
  const config = {
    get: (key: string) => {
      if (key === "smtp.enabled") return true;
      // Even with key emailing allowed for classic shares.
      if (key === "email.enableE2EKeyEmailSharing") return true;
      if (key === "general.appName") return "PrivCloud";
      return undefined;
    },
  };
  const emailService = {
    sendMailToShareRecipients: async (...args: unknown[]) => {
      mailed.push(args);
    },
    sendMailToReverseShareCreator: async (...args: unknown[]) => {
      mailed.push(args);
    },
  };
  const service = new ShareService(
    prisma as never,
    {} as never,
    {} as never,
    emailService as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    { sendToUser: async () => undefined } as never,
    {} as never,
    {} as never,
  );
  Object.assign(service, { logger: silentLogger });
  service.isShareCompleted = async () => false;

  await service.complete(share.id, "reverse-share-token", RS_KEY);
  // Notifications are sent after the response, on the next ticks.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(mailed.length, 2);
  assert.ok(!JSON.stringify(mailed).includes(RS_KEY));
});

testCase(
  "links the reverse share owner to the share without a key",
  async () => {
    const sent: { text: string }[] = [];
    const config = {
      get: (key: string) => {
        if (key === "general.appUrl") return "https://share.example.test";
        if (key === "email.reverseShareSubject")
          return "Reverse share link used";
        if (key === "email.reverseShareMessage") return "New share: {shareUrl}";
        return undefined;
      },
    };
    const email = new EmailService(config as never);
    Object.assign(email, {
      sendMail: async (_to: string, _subject: string, text: string) => {
        sent.push({ text });
      },
    });

    await email.sendMailToReverseShareCreator("owner@example.test", "share-1");

    assert.deepEqual(sent, [
      { text: "New share: https://share.example.test/s/share-1" },
    ]);
  },
);

void run();
