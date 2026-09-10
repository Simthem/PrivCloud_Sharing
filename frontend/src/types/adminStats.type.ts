/** One UTC day of the platform usage history. */
export type UsagePoint = {
  day: string;
  users: number | null;
  shares: number | null;
  views: number | null;
  /** Decimal string: the platform total overflows Number.MAX_SAFE_INTEGER. */
  storageBytes: string | null;
  /**
   * The point was rebuilt from surviving creation records instead of captured
   * on that day.
   */
  estimated: boolean;
};

export type UsageSeries = {
  from: string;
  to: string;
  months: number;
  points: UsagePoint[];
  totals: {
    users: number;
    shares: number;
    views: number;
    storageBytes: string;
  };
  /** First day backed by a recorded snapshot, null when none exists yet. */
  snapshotsFrom: string | null;
};
