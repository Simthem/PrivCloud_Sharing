import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "src/prisma/prisma.service";
import {
  accumulateUserCounts,
  buildUsageSeries,
  endOfDay,
  enumerateDays,
  startOfDay,
  subtractMonths,
  sumByteStrings,
  toDayKey,
  UsagePoint,
  UsageSnapshotRow,
} from "./usage-series.util";

/**
 * Files are read in pages so a large deployment never materialises its whole
 * inventory at once. Only the size column is selected, so the page can be
 * generous without costing much memory.
 */
const FILE_PAGE_SIZE = 5_000;
const CURRENT_TOTALS_CACHE_MS = 60_000;
const SHARE_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export type UsageTotals = {
  users: number;
  shares: number;
  views: number;
  storageBytes: string;
};

export type UsageSeries = {
  from: string;
  to: string;
  months: number;
  points: UsagePoint[];
  totals: UsageTotals;
  /**
   * First day backed by a real snapshot. Everything before it only carries a
   * user count, rebuilt from account creation dates.
   */
  snapshotsFrom: string | null;
};

@Injectable()
export class AdminStatsService {
  private readonly logger = new Logger(AdminStatsService.name);
  private totalsCache: { value: UsageTotals; expiresAt: number } | null = null;
  private totalsInFlight: Promise<UsageTotals> | null = null;

  constructor(private prisma: PrismaService) {}

  /**
   * Shares and their files are purged by the retention jobs, so the platform
   * history cannot be reconstructed after the fact: it only exists if it was
   * recorded day by day. This job is that recording.
   */
  // Capture the closing state of the UTC day. An implicit server timezone or
  // a shortly-after-midnight run can otherwise attach opening-of-day totals
  // to the new day and leave the preceding day without its final snapshot.
  @Cron("59 59 23 * * *", { timeZone: "UTC" })
  async recordDailySnapshot() {
    try {
      const day = toDayKey(new Date());
      await this.captureSnapshot(day, await this.currentTotals(true));
    } catch (error) {
      // A missing data point degrades a chart; it must never take down the
      // scheduler or the instance around it.
      this.logger.warn(
        `Could not record the daily usage snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async getUsageSeries(months: number): Promise<UsageSeries> {
    const to = toDayKey(new Date());

    // Reading the platform totals walks the whole file inventory, so it is
    // done once and serves both the response and the snapshot below.
    const totals = await this.currentTotals();

    // The cron only fires at night. Rewriting today keeps the last point of
    // the chart as fresh as the figures next to it; earlier days are already
    // recorded and are never touched again.
    await this.writeSnapshot(to, totals);

    const from = subtractMonths(to, months);
    const days = enumerateDays(from, to);

    const [snapshots, userCounts, snapshotsFrom] = await Promise.all([
      this.listSnapshots(from, to),
      this.rebuildUserCounts(days),
      this.findFirstSnapshotDay(),
    ]);

    return {
      from,
      to,
      months,
      points: buildUsageSeries(days, snapshots, userCounts),
      totals,
      snapshotsFrom,
    };
  }

  private async findFirstSnapshotDay(): Promise<string | null> {
    const first = await this.prisma.usageSnapshot.findFirst({
      orderBy: { day: "asc" },
      select: { day: true },
    });

    return first?.day ?? null;
  }

  private async listSnapshots(
    from: string,
    to: string,
  ): Promise<UsageSnapshotRow[]> {
    return this.prisma.usageSnapshot.findMany({
      where: { day: { gte: from, lte: to } },
      orderBy: { day: "asc" },
      select: {
        day: true,
        totalUsers: true,
        totalShares: true,
        totalViews: true,
        totalStorageBytes: true,
        backfilled: true,
      },
    });
  }

  /**
   * Recording must never be the reason an administrator cannot read the chart,
   * so a failed write is logged and the series is served anyway.
   */
  private async writeSnapshot(day: string, totals: UsageTotals) {
    try {
      await this.captureSnapshot(day, totals);
    } catch (error) {
      this.logger.warn(
        `Could not record today's usage snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async captureSnapshot(day: string, totals: UsageTotals) {
    try {
      await this.prisma.usageSnapshot.upsert({
        where: { day },
        create: {
          day,
          totalUsers: totals.users,
          totalShares: totals.shares,
          totalViews: totals.views,
          totalStorageBytes: totals.storageBytes,
          backfilled: false,
        },
        update: {
          totalUsers: totals.users,
          totalShares: totals.shares,
          totalViews: totals.views,
          totalStorageBytes: totals.storageBytes,
          backfilled: false,
        },
      });
    } catch (error) {
      // Both colours of a blue/green deployment run the same job. Losing the
      // race means the day is already recorded, which is the desired outcome.
      if (!isUniqueConstraintViolation(error)) throw error;
    }
  }

  /**
   * Coalesce concurrent dashboard reads and keep their expensive file scan for
   * one minute. The nightly snapshot bypasses an expired/fresh cache entry, but
   * can still share an already-running scan instead of doubling database load.
   */
  private async currentTotals(forceRefresh = false): Promise<UsageTotals> {
    const now = Date.now();
    if (!forceRefresh && this.totalsCache && this.totalsCache.expiresAt > now) {
      return this.totalsCache.value;
    }

    if (!this.totalsInFlight) {
      this.totalsInFlight = this.readCurrentTotals()
        .then((value) => {
          this.totalsCache = {
            value,
            expiresAt: Date.now() + CURRENT_TOTALS_CACHE_MS,
          };
          return value;
        })
        .finally(() => {
          this.totalsInFlight = null;
        });
    }

    return this.totalsInFlight;
  }

  private async readCurrentTotals(): Promise<UsageTotals> {
    const now = new Date();
    const shareWindowStartedAt = new Date(
      now.getTime() - SHARE_USAGE_WINDOW_MS,
    );
    const [users, shares, viewAggregate, storageBytes] = await Promise.all([
      this.prisma.user.count(),
      // The public edition has no immutable quota ledger, so count the
      // surviving shares created inside the same rolling window.
      this.prisma.share.count({
        where: {
          createdAt: { gt: shareWindowStartedAt, lte: now },
        },
      }),
      this.prisma.share.aggregate({ _sum: { views: true } }),
      this.totalStorageBytes(),
    ]);

    return {
      users,
      shares,
      views: viewAggregate._sum.views ?? 0,
      storageBytes,
    };
  }

  /**
   * File.size is a string column, so the database cannot sum it portably
   * across the PostgreSQL and SQLite builds. The sizes are added as BigInts
   * instead, one page at a time.
   *
   * The file id is read as a pagination cursor and nothing else: it never
   * leaves this method, and only the running total does.
   */
  private async totalStorageBytes(): Promise<string> {
    let total = "0";
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.file.findMany({
        take: FILE_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, size: true },
      });

      if (page.length === 0) break;

      total = sumByteStrings([total, ...page.map((file) => file.size)]);
      cursor = page[page.length - 1].id;

      if (page.length < FILE_PAGE_SIZE) break;
    }

    return total;
  }

  /**
   * Accounts are not purged on a schedule, so their creation dates still
   * describe the whole window. This is what lets the user curve cover months
   * that predate the first snapshot.
   */
  private async rebuildUserCounts(
    days: string[],
  ): Promise<Map<string, number>> {
    const windowStart = startOfDay(days[0]);
    const windowEnd = endOfDay(days[days.length - 1]);

    const [carriedOver, created] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { lt: windowStart } } }),
      this.prisma.user.findMany({
        where: { createdAt: { gte: windowStart, lt: windowEnd } },
        select: { createdAt: true },
      }),
    ]);

    const createdAtByDay = new Map<string, number>();
    for (const { createdAt } of created) {
      const day = toDayKey(createdAt);
      createdAtByDay.set(day, (createdAtByDay.get(day) ?? 0) + 1);
    }

    return accumulateUserCounts(days, createdAtByDay, carriedOver);
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
