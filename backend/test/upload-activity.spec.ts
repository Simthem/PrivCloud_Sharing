import assert from "node:assert/strict";
import { JobsService } from "src/jobs/jobs.service";
import {
  ABANDONED_UPLOAD_CLEANUP_CRON,
  ABANDONED_UPLOAD_TIMEOUT_MS,
  getAbandonedUploadCutoff,
  touchShareUploadActivity,
  UPLOAD_ACTIVITY_TOUCH_INTERVAL_MS,
} from "src/share/upload-activity.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("upload activity");

testCase("keeps abandoned-upload cleanup below one hour", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");

  assert.equal(ABANDONED_UPLOAD_TIMEOUT_MS, 45 * 60 * 1000);
  assert.equal(UPLOAD_ACTIVITY_TOUCH_INTERVAL_MS, 60 * 1000);
  assert.equal(ABANDONED_UPLOAD_CLEANUP_CRON, "*/5 * * * *");
  assert.equal(
    getAbandonedUploadCutoff(now).toISOString(),
    "2026-08-03T11:15:00.000Z",
  );
});

testCase("touches only active uploads whose heartbeat is stale", async () => {
  const updates: unknown[] = [];
  const prisma = {
    share: {
      updateMany: async (query: unknown) => {
        updates.push(query);
        return { count: 1 };
      },
    },
  };
  const now = new Date("2026-08-03T12:00:00.000Z");

  await touchShareUploadActivity(
    prisma as never,
    {
      id: "completed",
      uploadLocked: true,
      uploadLastActivityAt: new Date("2026-08-03T10:00:00.000Z"),
    },
    now,
  );
  await touchShareUploadActivity(
    prisma as never,
    {
      id: "recent",
      uploadLocked: false,
      uploadLastActivityAt: new Date("2026-08-03T11:59:30.000Z"),
    },
    now,
  );
  await touchShareUploadActivity(
    prisma as never,
    {
      id: "active",
      uploadLocked: false,
      uploadLastActivityAt: new Date("2026-08-03T11:58:00.000Z"),
    },
    now,
  );

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    where: {
      id: "active",
      uploadLocked: false,
      uploadCleanupStartedAt: null,
      uploadLastActivityAt: { lte: new Date("2026-08-03T11:59:00.000Z") },
    },
    data: { uploadLastActivityAt: now },
  });
});

testCase(
  "removes a stale unfinished upload and preserves it on storage failure",
  async () => {
    const runCleanup = async (
      storageFails: boolean,
      storageActivity: Date | null = null,
    ) => {
      let cleanupWhere: any;
      let storageDeletes = 0;
      const prisma: any = {
        runWithAdvisoryLock: async (
          _namespace: string,
          _name: string,
          job: () => Promise<void>,
        ) => {
          await job();
          return { acquired: true };
        },
        share: {
          findMany: async ({ where }: any) => {
            cleanupWhere = where;
            return [
              {
                id: "stale-share",
                storageProvider: "S3",
                hasBeenCompleted: false,
              },
            ];
          },
          updateMany: async () => ({ count: 1 }),
          deleteMany: async () => ({ count: 1 }),
        },
      };
      const jobs = new JobsService(
        prisma,
        {} as never,
        {
          getRecentUploadActivity: async () => storageActivity,
          deleteAllFiles: async () => {
            storageDeletes++;
            if (storageFails) throw new Error("storage unavailable");
          },
        } as never,
        {} as never,
        {} as never,
      );
      (jobs as any).logger = {
        debug: () => undefined,
        warn: () => undefined,
        log: () => undefined,
      };

      const before = Date.now();
      await jobs.deleteUnfinishedShares();
      const after = Date.now();

      assert.equal(cleanupWhere.uploadLocked, false);
      assert.equal(cleanupWhere.uploadCleanupStartedAt, null);
      const cutoff = cleanupWhere.uploadLastActivityAt.lt.getTime();
      assert.ok(cutoff >= before - ABANDONED_UPLOAD_TIMEOUT_MS);
      assert.ok(cutoff <= after - ABANDONED_UPLOAD_TIMEOUT_MS);
      return { storageDeletes };
    };

    assert.deepEqual(await runCleanup(false), {
      storageDeletes: 1,
    });
    assert.deepEqual(await runCleanup(true), {
      storageDeletes: 1,
    });
    assert.deepEqual(
      await runCleanup(false, new Date()),
      { storageDeletes: 0 },
      "recent storage activity must protect old-color uploads",
    );
  },
);

testCase(
  "relocks an abandoned edit of a completed share without touching storage",
  async () => {
    let relockQuery: any;
    let storageCalls = 0;
    const prisma: any = {
      runWithAdvisoryLock: async (
        _namespace: string,
        _name: string,
        job: () => Promise<void>,
      ) => {
        await job();
        return { acquired: true };
      },
      share: {
        findMany: async () => [
          {
            id: "existing-share",
            storageProvider: "S3",
            hasBeenCompleted: true,
          },
        ],
        updateMany: async (query: any) => {
          relockQuery = query;
          return { count: 1 };
        },
      },
    };
    const jobs = new JobsService(
      prisma,
      {} as never,
      {
        getRecentUploadActivity: async () => {
          storageCalls++;
          return null;
        },
        deleteAllFiles: async () => {
          storageCalls++;
        },
      } as never,
      {} as never,
      {} as never,
    );
    (jobs as any).logger = {
      debug: () => undefined,
      warn: () => undefined,
      log: () => undefined,
    };

    await jobs.deleteUnfinishedShares();

    assert.equal(storageCalls, 0);
    assert.equal(relockQuery.where.id, "existing-share");
    assert.equal(relockQuery.where.hasBeenCompleted, true);
    assert.equal(relockQuery.where.uploadLocked, false);
    assert.equal(relockQuery.where.uploadCleanupStartedAt, null);
    assert.ok(relockQuery.where.uploadLastActivityAt.lt instanceof Date);
    assert.deepEqual(relockQuery.data, { uploadLocked: true });
  },
);

void run();
