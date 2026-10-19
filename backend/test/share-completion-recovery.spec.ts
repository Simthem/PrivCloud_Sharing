import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ShareService } from "src/share/share.service";
import { CompletedShareDTO } from "src/share/dto/shareComplete.dto";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("persisted upload completion");

function fixture(smtpEnabled: boolean, recipients: { email: string }[] = []) {
  let emails = 0;
  let remainingUses = 1;
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
    reverseShare: {
      updateMany: async () => {
        if (remainingUses <= 0) return { count: 0 };
        remainingUses--;
        return { count: 1 };
      },
    },
  };
  const service = Object.create(ShareService.prototype) as ShareService;
  Object.assign(service, {
    prisma: {
      ...tx,
      $transaction: async (
        callback: (client: typeof tx) => Promise<unknown>,
      ) => {
        const before = {
          uploadLocked: share.uploadLocked,
          hasBeenCompleted: share.hasBeenCompleted,
        };
        const beforeUses = remainingUses;
        try {
          return await callback(tx);
        } catch (error) {
          Object.assign(share, before);
          remainingUses = beforeUses;
          throw error;
        }
      },
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
    get remainingUses() {
      return remainingUses;
    },
    set remainingUses(value: number) {
      remainingUses = value;
    },
  };
}

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Completion waited for notification delivery")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

testCase(
  "a blocked SMTP send cannot delay the persisted completion response",
  async () => {
    const upload = fixture(true, [{ email: "recipient@example.test" }]);
    let release!: () => void;
    let sentAfterCommit = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(upload.service, {
      emailService: {
        sendMailToShareRecipients: () => {
          sentAfterCommit =
            upload.share.uploadLocked && upload.share.hasBeenCompleted;
          return blocked;
        },
      },
    });
    try {
      const completed = await promptly(
        upload.service.complete(upload.share.id),
      );
      assert.equal(sentAfterCommit, true);
      assert.equal(
        new CompletedShareDTO().from(completed).uploadPending,
        false,
      );
    } finally {
      release();
    }
  },
);

testCase(
  "a depleted reverse link rolls back completion without notification side effects",
  async () => {
    const upload = fixture(true, [{ email: "recipient@example.test" }]);
    upload.remainingUses = 0;
    Object.assign(upload.share, {
      reverseShare: {
        creatorId: "reverse-owner",
        creator: { email: "owner@example.test" },
        shareExpiration: new Date(Date.now() + 86_400_000),
        sendEmailNotification: true,
      },
    });
    await assert.rejects(
      () => upload.service.complete(upload.share.id, "reverse-token"),
      ForbiddenException,
    );
    assert.equal(upload.share.uploadLocked, false);
    assert.equal(upload.share.hasBeenCompleted, false);
    assert.equal(upload.remainingUses, 0);
    assert.equal(upload.emails, 0);
  },
);

testCase(
  "a slow reverse-owner email never carries the link key and does not claim delivery in the response",
  async () => {
    const upload = fixture(true, [{ email: "recipient@example.test" }]);
    Object.assign(upload.share, {
      reverseShare: {
        creatorId: "reverse-owner",
        creator: { email: "owner@example.test" },
        shareExpiration: new Date(Date.now() + 86_400_000),
        sendEmailNotification: true,
      },
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recipientKey: unknown = "unset";
    let ownerArgs: unknown[] | undefined;
    Object.assign(upload.service, {
      emailService: {
        sendMailToShareRecipients: async (...args: unknown[]) => {
          recipientKey = args[6];
        },
        sendMailToReverseShareCreator: (...args: unknown[]) => {
          ownerArgs = args;
          assert.equal(upload.share.uploadLocked, true);
          assert.equal(upload.remainingUses, 0);
          return blocked;
        },
      },
    });
    try {
      const completed = await promptly(
        upload.service.complete(
          upload.share.id,
          "reverse-token",
          "owner-link-key",
        ),
      );
      assert.equal(recipientKey, undefined);
      // The owner unwraps K_rs in the browser: the link never carries it.
      assert.deepEqual(ownerArgs, ["owner@example.test", upload.share.id]);
      assert.notEqual(completed.notifyReverseShareCreator, true);
      assert.equal(
        new CompletedShareDTO().from(completed).uploadPending,
        false,
      );
    } finally {
      release();
    }
  },
);

testCase(
  "concurrent completions claim the share once and send one recipient notification",
  async () => {
    const upload = fixture(true, [{ email: "recipient@example.test" }]);
    const results = await Promise.allSettled([
      upload.service.complete(upload.share.id),
      upload.service.complete(upload.share.id),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(upload.emails, 1);
    assert.equal(upload.share.uploadLocked, true);
  },
);

void run();
