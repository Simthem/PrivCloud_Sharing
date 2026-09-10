/**
 * Pure helpers behind the administration usage chart.
 *
 * Everything here works on UTC calendar days encoded as "YYYY-MM-DD". A string
 * key keeps the series identical on PostgreSQL and SQLite, survives the daylight
 * saving transitions of any server timezone, and sorts lexicographically, which
 * is what the chart needs.
 */

export type UsageSnapshotRow = {
  day: string;
  totalUsers: number;
  totalShares: number;
  totalViews: number | null;
  totalStorageBytes: string;
  backfilled: boolean;
};

export type UsagePoint = {
  day: string;
  users: number | null;
  shares: number | null;
  views: number | null;
  storageBytes: string | null;
  /**
   * True when the point was rebuilt from surviving creation records rather
   * than captured on that day.
   */
  estimated: boolean;
};

export const MIN_USAGE_MONTHS = 1;
export const MAX_USAGE_MONTHS = 24;
export const DEFAULT_USAGE_MONTHS = 6;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC calendar day of a timestamp, as "YYYY-MM-DD". */
export function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC opening the given day. */
export function startOfDay(day: string): Date {
  if (!DAY_KEY_PATTERN.test(day)) {
    throw new Error(`Invalid day key: ${day}`);
  }
  return new Date(`${day}T00:00:00.000Z`);
}

/** Midnight UTC opening the next day, i.e. the exclusive end of `day`. */
export function endOfDay(day: string): Date {
  return new Date(startOfDay(day).getTime() + MS_PER_DAY);
}

/**
 * Move back whole months, clamping to the last day of the target month so that
 * "6 months before the 31st" never overflows into the following month.
 */
export function subtractMonths(day: string, months: number): string {
  const anchor = startOfDay(day);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const date = anchor.getUTCDate();

  const target = new Date(Date.UTC(year, month - months, 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(date, lastDayOfTargetMonth));
  return toDayKey(target);
}

/** Every day from `from` to `to`, both inclusive. */
export function enumerateDays(from: string, to: string): string[] {
  const last = startOfDay(to).getTime();
  const days: string[] = [];

  for (
    let cursor = startOfDay(from).getTime();
    cursor <= last;
    cursor += MS_PER_DAY
  ) {
    days.push(toDayKey(new Date(cursor)));
  }

  return days;
}

/**
 * File.size is a string because a single upload already overflows a 32-bit
 * integer; the platform total overflows Number.MAX_SAFE_INTEGER even sooner.
 * The running sum therefore stays a BigInt and leaves as a decimal string.
 */
export function sumByteStrings(sizes: string[]): string {
  let total = 0n;

  for (const size of sizes) {
    try {
      const value = BigInt(size);
      // A negative size can only be corrupted data; ignoring it keeps the
      // total monotonic instead of silently under-reporting storage.
      if (value > 0n) total += value;
    } catch {
      // Non-numeric legacy rows must not take the whole snapshot down.
    }
  }

  return total.toString();
}

/**
 * Cumulative user count at the end of each day, derived from creation dates.
 *
 * `createdAtByDay` holds the number of accounts created on each day of the
 * window and `carriedOver` the number that already existed before it.
 */
export function accumulateUserCounts(
  days: string[],
  createdAtByDay: Map<string, number>,
  carriedOver: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  let running = carriedOver;

  for (const day of days) {
    running += createdAtByDay.get(day) ?? 0;
    counts.set(day, running);
  }

  return counts;
}

/**
 * Merge the recorded snapshots with the rebuilt user counts.
 *
 * A snapshot always wins. Days without one keep null share, view and storage
 * values so the chart opens real gaps instead of drawing zeroes that never
 * happened.
 */
export function buildUsageSeries(
  days: string[],
  snapshots: UsageSnapshotRow[],
  userCounts: Map<string, number>,
): UsagePoint[] {
  const byDay = new Map(snapshots.map((snapshot) => [snapshot.day, snapshot]));

  return days.map((day) => {
    const snapshot = byDay.get(day);

    if (snapshot) {
      return {
        day,
        users: snapshot.totalUsers,
        shares: snapshot.totalShares,
        views: snapshot.totalViews,
        storageBytes: snapshot.totalStorageBytes,
        estimated: snapshot.backfilled,
      };
    }

    const users = userCounts.get(day);

    return {
      day,
      users: users ?? null,
      shares: null,
      views: null,
      storageBytes: null,
      estimated: users !== undefined,
    };
  });
}

/** Keep a client-supplied window inside the range the chart supports. */
export function normalizeMonths(raw: unknown): number {
  const parsed =
    typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);

  if (!Number.isFinite(parsed)) return DEFAULT_USAGE_MONTHS;

  return Math.min(
    MAX_USAGE_MONTHS,
    Math.max(MIN_USAGE_MONTHS, Math.trunc(parsed)),
  );
}
