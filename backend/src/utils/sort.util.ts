/** Names are encrypted at rest: the database cannot order them. */
export const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

/** Sums counts per key, highest first, since one value may be stored in both forms. */
export const topCounts = (
  rows: { key: string; count: number }[],
  limit: number,
) => {
  const totals = new Map<string, number>();
  for (const { key, count } of rows) {
    totals.set(key, (totals.get(key) ?? 0) + count);
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
};
