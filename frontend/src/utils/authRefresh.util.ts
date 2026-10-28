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

const REAUTHENTICATION =
  /^\/?auth\/(?:password|email-change|totp\/(?:enable|verify|disable)|passkey\/registration|step-up(?:\/passkey)?)$/;

/**
 * A 403 from a route that asks for the current password or a 2FA code means
 * that proof was refused, not that the session expired. Replaying it after a
 * refresh would count one typo twice towards the account's sign-in lock.
 */
export function isReauthenticationRefusal(status?: number, url?: string) {
  return status === 403 && REAUTHENTICATION.test((url ?? "").split("?")[0]);
}
