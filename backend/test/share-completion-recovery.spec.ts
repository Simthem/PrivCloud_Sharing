import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { ShareService } from "src/share/share.service";
import { CompletedShareDTO } from "src/share/dto/shareComplete.dto";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("persisted upload completion");

function fixture(smtpEnabled: boolean, recipients: { email: string }[] = []) {
  let emails = 0;
  const share = {
    id: "share-1",
    creatorId: "owner-1",
    creator: { id: "owner-1", username: "owner", email: "owner@example.test" },
    name: "encrypted-name",
    description: null,
    createdAt: new Date(),
    expiration: new Date(Date.now() + 86_400_000),
    uploadLastActivityAt: new Date(),
    uploadCleanupStartedAt: null,
    uploadLocked: false,
    hasBeenCompleted: false,
    removedReason: null,
    isE2EEncrypted: true,
    files: [
      { id: "file-1", name: "encrypted-name", size: "42", relativePath: null },
    ],
    recipients,
    reverseShare: null,
    teamFolder: null,
    teamFolderId: null,
    teamFileRequestId: null,
  };
  const shareStore = {
    findUnique: async () => ({ ...share }),
    findUniqueOrThrow: async () => ({ ...share }),
    findMany: async ({
      where,
    }: {
      where: { creatorId: string; uploadLocked: boolean };
    }) =>
      where.creatorId === share.creatorId &&
      where.uploadLocked === share.uploadLocked
        ? [{ ...share }]
        : [],
    update: async ({ data }: { data: Partial<typeof share> }) => {
      Object.assign(share, data);
      return { ...share };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { uploadLocked: boolean };
      data: Partial<typeof share>;
    }) => {
      if (where.uploadLocked !== share.uploadLocked) return { count: 0 };
      Object.assign(share, data);
      return { count: 1 };
    },
  };
  const tx = {
    share: shareStore,
    shareQuotaEvent: { updateMany: async () => ({ count: 1 }) },
  };
  const service = Object.create(ShareService.prototype) as ShareService;
  Object.assign(service, {
    prisma: {
      ...tx,
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
    },
    config: {
      get: (key: string) =>
        key === "smtp.enabled"
          ? smtpEnabled
          : key === "general.appName"
            ? "PrivCloud"
            : false,
    },
    logger: { debug() {}, log() {}, warn() {}, error() {} },
    emailService: {
      sendMailToShareRecipients: async () => {
        emails++;
        throw new Error("SMTP unavailable");
      },
    },
    pushService: { sendToUser: async () => undefined },
  });
  return {
    service,
    share,
    get emails() {
      return emails;
    },
  };
}

for (const smtpEnabled of [false, true]) {
  testCase(
    `a link share without recipients finalizes with SMTP ${smtpEnabled ? "enabled" : "disabled"}`,
    async () => {
      const upload = fixture(smtpEnabled);
      assert.equal(
        (await upload.service.getPendingUploadsByUser("owner-1")).length,
        1,
      );
      const completed = await upload.service.complete(upload.share.id);
      assert.equal(upload.share.uploadLocked, true);
      assert.equal(upload.share.hasBeenCompleted, true);
      assert.equal(
        new CompletedShareDTO().from(completed).uploadPending,
        false,
      );
      assert.deepEqual(
        await upload.service.getPendingUploadsByUser("owner-1"),
        [],
      );
      assert.equal(upload.emails, 0);
    },
  );
}

testCase(
  "recipient email failure leaves the saved share finalized",
  async () => {
    const upload = fixture(true, [{ email: "recipient@example.test" }]);
    const completed = await upload.service.complete(upload.share.id);
    assert.equal(upload.emails, 1);
    assert.equal(upload.share.uploadLocked, true);
    assert.equal(new CompletedShareDTO().from(completed).uploadPending, false);
    assert.deepEqual(
      await upload.service.getPendingUploadsByUser("owner-1"),
      [],
    );
  },
);

testCase(
  "a share without saved files stays pending and cannot acknowledge completion",
  async () => {
    const upload = fixture(true);
    upload.share.files = [];
    await assert.rejects(
      () => upload.service.complete(upload.share.id),
      BadRequestException,
    );
    assert.equal(upload.share.uploadLocked, false);
    assert.equal(upload.share.hasBeenCompleted, false);
  },
);

void run();
