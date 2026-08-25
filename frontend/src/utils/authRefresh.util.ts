export type AuthRefreshResult = {
  ok: boolean;
  status: number;
};

type RefreshAttempt = () => Promise<AuthRefreshResult>;

const wait = (delayMs: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));

/** Retry one 401 after another browser context may have rotated the cookie. */
export async function refreshAfterPossibleCookieRotation(
  attempt: RefreshAttempt,
  retryDelayMs = 450,
): Promise<AuthRefreshResult> {
  const first = await attempt();
  if (first.ok || first.status !== 401) return first;

  await wait(Math.max(0, retryDelayMs));
  return attempt();
}
