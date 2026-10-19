export function rotationDaysRemaining(
  nextDueAt: string,
  now = Date.now(),
): number | null {
  const due = Date.parse(nextDueAt);
  return Number.isFinite(due)
    ? Math.max(0, Math.ceil((due - now) / 86_400_000))
    : null;
}
