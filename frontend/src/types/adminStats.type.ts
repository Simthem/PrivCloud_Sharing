/** One UTC day of the platform usage history. */
export type UsagePoint = {
  day: string;
  users: number | null;
  shares: number | null;
  /** Decimal string: the platform total overflows Number.MAX_SAFE_INTEGER. */
  storageBytes: string | null;
  /**
   * The day predates the snapshot history and was rebuilt from account
   * creation dates. Only `users` can be rebuilt that way.
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
    storageBytes: string;
  };
  /** First day backed by a recorded snapshot, null when none exists yet. */
  snapshotsFrom: string | null;
};
