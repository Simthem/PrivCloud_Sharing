import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { ShareService } from "src/share/share.service";
import { normalizeShareRecipients } from "src/share/share-recipient.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("share completion idempotency");

testCase("deduplicates recipient addresses case-insensitively", () => {
  assert.deepEqual(
    normalizeShareRecipients([
      " recipient@example.test ",
      "RECIPIENT@example.test",
      "second@example.test",
      "second@example.test",
    ]),
    ["recipient@example.test", "second@example.test"],
  );
});

testCase(
  "allows only one concurrent completion to send recipient mail",
  async () => {
    let uploadLocked = false;
    let recipientMailCount = 0;
    let completionData: unknown;

    const share = {
      id: "first-e2e-share",
      name: "First E2E share",
      description: null,
      expiration: new Date(Date.now() + 86_400_000),
      uploadLocked: false,
      uploadLastActivityAt: new Date(),
      uploadCleanupStartedAt: null,
      isE2EEncrypted: true,
      creatorId: "creator-1",
      creator: {
        id: "creator-1",
        username: "creator",
        email: "creator@example.test",
      },
      files: [
        {
          id: "file-1",
          name: "document.pdf",
          size: "42",
          relativePath: null,
        },
      ],
      recipients: [
        { email: "recipient@example.test" },
        { email: "RECIPIENT@example.test" },
      ],
      reverseShare: null,
      teamFolder: null,
    };

    const transactionClient = {
      share: {
        updateMany: async ({ data }: { data: unknown }) => {
          completionData = data;
          if (uploadLocked) return { count: 0 };
          uploadLocked = true;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({ ...share, uploadLocked: true }),
      },
      reverseShare: {
        updateMany: async () => ({ count: 1 }),
      },
    };

    const prisma = {
      share: {
        findUnique: async () => share,
      },
      $transaction: async (
        callback: (tx: typeof transactionClient) => Promise<unknown>,
      ) => callback(transactionClient),
    };
    const config = {
      get: (key: string) => {
        if (key === "smtp.enabled") return true;
        if (key === "email.enableE2EKeyEmailSharing") return false;
        if (key === "general.appName") return "PrivCloud";
        return undefined;
      },
    };
    const emailService = {
      sendMailToShareRecipients: async () => {
        recipientMailCount++;
        await Promise.resolve();
      },
    };
    const pushService = { sendToUser: async () => undefined };
    const service = new ShareService(
      prisma as never,
      {} as never,
      {} as never,
      emailService as never,
      config as never,
      {} as never,
      {} as never,
      {} as never,
      pushService as never,
    );
    Object.assign(service, {
      logger: {
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        log: () => undefined,
      },
    });
    // Force both requests past the non-atomic fast-path read. The transactional
    // compare-and-set must still allow exactly one of them to continue.
    service.isShareCompleted = async () => false;

    const results = await Promise.allSettled([
      service.complete(share.id),
      service.complete(share.id),
    ]);

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected?.reason instanceof BadRequestException);
    assert.equal(recipientMailCount, 1);
    assert.deepEqual(completionData, {
      uploadLocked: true,
      hasBeenCompleted: true,
    });
  },
);

void run();
