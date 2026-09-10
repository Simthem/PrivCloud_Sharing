import assert from "node:assert/strict";
import { AdminStatsService } from "src/adminStats/adminStats.service";
import {
  accumulateUserCounts,
  buildUsageSeries,
  enumerateDays,
  normalizeMonths,
  subtractMonths,
  sumByteStrings,
  toDayKey,
  UsageSnapshotRow,
} from "src/adminStats/usage-series.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("admin usage stats");

testCase(
  "walks back whole months without overflowing into the next one",
  () => {
    assert.equal(subtractMonths("2026-09-08", 6), "2026-03-08");
    // 31 August minus one month is 31 July, but minus six months has no 31st.
    assert.equal(subtractMonths("2026-08-31", 6), "2026-02-28");
    assert.equal(subtractMonths("2026-01-15", 12), "2025-01-15");
  },
);

testCase("enumerates inclusive day ranges across month boundaries", () => {
  assert.deepEqual(enumerateDays("2026-02-27", "2026-03-02"), [
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
    "2026-03-02",
  ]);
  assert.deepEqual(enumerateDays("2026-09-08", "2026-09-08"), ["2026-09-08"]);
  assert.equal(enumerateDays("2026-03-08", "2026-09-08").length, 185);
});

testCase("keys days in UTC regardless of the local timezone", () => {
  assert.equal(toDayKey(new Date("2026-09-08T23:59:59.000Z")), "2026-09-08");
  assert.equal(toDayKey(new Date("2026-09-09T00:00:00.000Z")), "2026-09-09");
});

testCase("sums file sizes beyond the safe integer range", () => {
  const petabyte = "1000000000000000";
  assert.equal(
    sumByteStrings([petabyte, petabyte, petabyte]),
    "3000000000000000",
  );
  assert.equal(
    sumByteStrings(["9007199254740993", "1"]),
    "9007199254740994",
    "a BigInt sum must not round like a double",
  );
  assert.equal(sumByteStrings([]), "0");
  // Corrupted rows must not take a whole snapshot down.
  assert.equal(sumByteStrings(["12", "not-a-number", "-5", "30"]), "42");
});

testCase("accumulates user creations into a running total", () => {
  const days = enumerateDays("2026-09-01", "2026-09-04");
  const counts = accumulateUserCounts(
    days,
    new Map([
      ["2026-09-02", 3],
      ["2026-09-04", 1],
    ]),
    10,
  );

  assert.deepEqual(
    days.map((day) => counts.get(day)),
    [10, 13, 13, 14],
  );
});

testCase("prefers snapshots and never invents share or storage history", () => {
  const days = enumerateDays("2026-09-01", "2026-09-04");
  const userCounts = accumulateUserCounts(
    days,
    new Map([["2026-09-03", 2]]),
    5,
  );

  const points = buildUsageSeries(
    days,
    [
      {
        day: "2026-09-03",
        totalUsers: 6,
        totalShares: 12,
        totalViews: null,
        totalStorageBytes: "500",
        backfilled: true,
      },
      {
        day: "2026-09-04",
        totalUsers: 7,
        totalShares: 15,
        totalViews: 24,
        totalStorageBytes: "900",
        backfilled: false,
      },
    ],
    userCounts,
  );

  // Days without a snapshot keep a rebuilt user count and nothing else: the
  // shares and files of that day were purged and cannot be recovered.
  assert.deepEqual(points[0], {
    day: "2026-09-01",
    users: 5,
    shares: null,
    views: null,
    storageBytes: null,
    estimated: true,
  });
  assert.deepEqual(points[2], {
    day: "2026-09-03",
    users: 6,
    shares: 12,
    views: null,
    storageBytes: "500",
    estimated: true,
  });
});

testCase("clamps the requested window to a supported range", () => {
  assert.equal(normalizeMonths("6"), 6);
  assert.equal(normalizeMonths(undefined), 6);
  assert.equal(normalizeMonths("not-a-number"), 6);
  assert.equal(normalizeMonths("0"), 1);
  assert.equal(normalizeMonths("-12"), 1);
  assert.equal(normalizeMonths("999"), 24);
});

/**
 * A Prisma stand-in with just enough behaviour to exercise the service: an
 * id-cursor file table, a single-row user table and an in-memory snapshot
 * table. It keeps the read path testable without a database.
 */
function fakePrisma(options: {
  users?: Date[];
  shares?: number;
  views?: number;
  files?: { id: string; size: string }[];
  snapshots?: UsageSnapshotRow[];
}) {
  const users = options.users ?? [];
  const files = [...(options.files ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const snapshots = new Map(
    (options.snapshots ?? []).map((snapshot) => [snapshot.day, snapshot]),
  );
  const filePages: number[] = [];
  const shareCountQueries: unknown[] = [];

  return {
    filePages,
    shareCountQueries,
    snapshots,
    user: {
      count: async (query?: { where?: { createdAt?: { lt?: Date } } }) => {
        const before = query?.where?.createdAt?.lt;
        return before
          ? users.filter((createdAt) => createdAt < before).length
          : users.length;
      },
      findMany: async (query: {
        where: { createdAt: { gte: Date; lt: Date } };
      }) =>
        users
          .filter(
            (createdAt) =>
              createdAt >= query.where.createdAt.gte &&
              createdAt < query.where.createdAt.lt,
          )
          .map((createdAt) => ({ createdAt })),
    },
    share: {
      count: async (query?: unknown) => {
        shareCountQueries.push(query);
        return options.shares ?? 0;
      },
      aggregate: async () => ({ _sum: { views: options.views ?? null } }),
    },
    shareQuotaEvent: {
      count: async () => options.shares ?? 0,
    },
    file: {
      findMany: async (query: {
        take: number;
        cursor?: { id: string };
        skip?: number;
      }) => {
        const start = query.cursor
          ? files.findIndex((file) => file.id === query.cursor!.id) + 1
          : 0;
        const page = files.slice(start, start + query.take);
        filePages.push(page.length);
        return page;
      },
    },
    usageSnapshot: {
      findUnique: async ({ where }: { where: { day: string } }) =>
        snapshots.get(where.day) ?? null,
      findMany: async ({
        where,
      }: {
        where: { day: { gte: string; lte: string } };
      }) =>
        [...snapshots.values()]
          .filter(
            (snapshot) =>
              snapshot.day >= where.day.gte && snapshot.day <= where.day.lte,
          )
          .sort((a, b) => a.day.localeCompare(b.day)),
      findFirst: async () => {
        const first = [...snapshots.values()].sort((a, b) =>
          a.day.localeCompare(b.day),
        )[0];
        return first ? { day: first.day } : null;
      },
      upsert: async ({
        where,
        create,
      }: {
        where: { day: string };
        create: UsageSnapshotRow;
      }) => {
        snapshots.set(where.day, create);
        return create;
      },
    },
  };
}

testCase("adds up file sizes one page at a time", async () => {
  // Three pages exactly: the loop must stop on the empty page rather than
  // looping forever on a full last page.
  const files = Array.from({ length: 10_000 }, (_, index) => ({
    id: `file-${String(index).padStart(6, "0")}`,
    size: "1000000000",
  }));
  const prisma = fakePrisma({
    files,
    shares: 4,
    views: 17,
    users: [new Date()],
  });
  const service = new AdminStatsService(prisma as never);

  const series = await service.getUsageSeries(1);

  assert.deepEqual(prisma.filePages, [5_000, 5_000, 0]);
  assert.equal(series.totals.storageBytes, "10000000000000");
  assert.equal(series.totals.shares, 4);
  assert.equal(series.totals.views, 17);
  const shareWindow = prisma.shareCountQueries[0] as {
    where: { createdAt: { gt: Date; lte: Date } };
  };
  assert.equal(
    shareWindow.where.createdAt.lte.getTime() -
      shareWindow.where.createdAt.gt.getTime(),
    30 * 24 * 60 * 60 * 1_000,
  );
});

testCase(
  "coalesces concurrent totals and briefly reuses their file scan",
  async () => {
    const prisma = fakePrisma({
      users: [new Date("2026-01-01T00:00:00.000Z")],
      shares: 2,
      files: [{ id: "a", size: "512" }],
    });
    const service = new AdminStatsService(prisma as never);

    await Promise.all([service.getUsageSeries(1), service.getUsageSeries(3)]);
    await service.getUsageSeries(6);

    assert.deepEqual(
      prisma.filePages,
      [1],
      "one inventory scan should serve concurrent and immediately repeated reads",
    );
  },
);

testCase(
  "records today on read so the chart is never a day behind",
  async () => {
    const prisma = fakePrisma({
      users: [new Date("2026-01-01T09:00:00.000Z")],
      shares: 2,
      files: [{ id: "a", size: "512" }],
    });
    const service = new AdminStatsService(prisma as never);

    const series = await service.getUsageSeries(6);
    const today = toDayKey(new Date());

    assert.equal(prisma.snapshots.size, 1);
    assert.deepEqual(prisma.snapshots.get(today), {
      day: today,
      totalUsers: 1,
      totalShares: 2,
      totalViews: 0,
      totalStorageBytes: "512",
      backfilled: false,
    });

    assert.equal(series.months, 6);
    assert.equal(series.to, today);
    assert.equal(series.from, subtractMonths(today, 6));
    assert.equal(series.snapshotsFrom, today);

    const last = series.points[series.points.length - 1];
    assert.deepEqual(last, {
      day: today,
      users: 1,
      shares: 2,
      views: 0,
      storageBytes: "512",
      estimated: false,
    });

    // Every earlier day carries the rebuilt account count and nothing else.
    assert.ok(series.points.slice(0, -1).every((point) => point.estimated));
    assert.ok(
      series.points.slice(0, -1).every((point) => point.shares === null),
    );
    assert.equal(series.points[0].users, 1);
  },
);

testCase(
  "reports the first real snapshot even when it predates the window",
  async () => {
    const prisma = fakePrisma({
      snapshots: [
        {
          day: "2024-01-02",
          totalUsers: 1,
          totalShares: 1,
          totalViews: null,
          totalStorageBytes: "128",
          backfilled: false,
        },
      ],
    });
    const service = new AdminStatsService(prisma as never);

    const series = await service.getUsageSeries(1);

    assert.equal(series.snapshotsFrom, "2024-01-02");
    assert.ok(
      series.points.every((point) => point.day !== "2024-01-02"),
      "the response should not expand beyond the requested chart window",
    );
  },
);

testCase(
  "schedules the daily snapshot at the end of an explicit UTC day",
  () => {
    const schedule = Reflect.getMetadata(
      "SCHEDULE_CRON_OPTIONS",
      AdminStatsService.prototype.recordDailySnapshot,
    );

    assert.equal(schedule?.cronTime, "59 59 23 * * *");
    assert.equal(schedule?.timeZone, "UTC");
  },
);

testCase("refreshes today on read and freezes every earlier day", async () => {
  const today = toDayKey(new Date());
  const yesterday = enumerateDays(subtractMonths(today, 1), today).at(-2)!;
  const frozen = {
    day: yesterday,
    totalUsers: 99,
    totalShares: 99,
    totalViews: 99,
    totalStorageBytes: "99",
    backfilled: false,
  };
  const prisma = fakePrisma({
    snapshots: [
      frozen,
      {
        day: today,
        totalUsers: 0,
        totalShares: 0,
        totalViews: 0,
        totalStorageBytes: "0",
        backfilled: false,
      },
    ],
    shares: 1,
    files: [{ id: "a", size: "4096" }],
  });
  const service = new AdminStatsService(prisma as never);

  const series = await service.getUsageSeries(1);

  // Yesterday is history and stays exactly as it was recorded, even where it
  // disagrees with the live counters.
  assert.deepEqual(prisma.snapshots.get(yesterday), frozen);
  const yesterdayPoint = series.points.find((point) => point.day === yesterday);
  assert.equal(yesterdayPoint?.shares, 99);

  // Today is still in progress, so it tracks the figures shown next to it.
  assert.deepEqual(prisma.snapshots.get(today), {
    day: today,
    totalUsers: 0,
    totalShares: 1,
    totalViews: 0,
    totalStorageBytes: "4096",
    backfilled: false,
  });
  assert.deepEqual(series.points[series.points.length - 1], {
    day: today,
    users: 0,
    shares: 1,
    views: 0,
    storageBytes: "4096",
    estimated: false,
  });
  assert.equal(series.snapshotsFrom, yesterday);
});

testCase(
  "stores counters only, never anything describing a user or a share",
  async () => {
    const prisma = fakePrisma({
      users: [new Date()],
      shares: 3,
      files: [{ id: "secret-file-id", size: "128" }],
    });
    const service = new AdminStatsService(prisma as never);

    const series = await service.getUsageSeries(6);
    const today = toDayKey(new Date());

    // Retention deletes what users entrusted to the platform. The chart must
    // never become a reason to keep a shadow copy of it, so the recorded row is
    // pinned to exactly these aggregate fields.
    assert.deepEqual(Object.keys(prisma.snapshots.get(today)!).sort(), [
      "backfilled",
      "day",
      "totalShares",
      "totalStorageBytes",
      "totalUsers",
      "totalViews",
    ]);

    // The same goes for what leaves over HTTP: dates, counts, one boolean.
    const serialized = JSON.stringify(series);
    for (const identifier of ["secret-file-id", "creatorId", "senderEmail"]) {
      assert.ok(
        !serialized.includes(identifier),
        `${identifier} must never reach the usage series`,
      );
    }
    assert.deepEqual(Object.keys(series.points[0]).sort(), [
      "day",
      "estimated",
      "shares",
      "storageBytes",
      "users",
      "views",
    ]);
    assert.deepEqual(Object.keys(series.totals).sort(), [
      "shares",
      "storageBytes",
      "users",
      "views",
    ]);
  },
);

void run();
