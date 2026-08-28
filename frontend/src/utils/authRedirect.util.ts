const SIGN_IN_PATH = "/auth/signIn";
const LOCAL_URL_BASE = "https://privcloud.invalid";
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
const POST_AUTH_TARGET_STORAGE_KEY = "privcloud.postAuthTarget";
const POST_AUTH_TARGET_TTL_MS = 15 * 60 * 1000;
const TEAM_KEY_FRAGMENT =
  /^#teamKey=[A-Za-z0-9_-]{16,4096}(?:&version=[1-9][0-9]{0,9})?$/;
export const AUTH_SESSION_EXPIRED_EVENT = "privcloud:auth-session-expired";

/**
 * Accept only same-origin application paths as post-authentication targets.
 *
 * The value can come from the query string, so it must not be possible to turn
 * it into an absolute or protocol-relative URL. Returning "/" on invalid input
 * gives callers a deterministic, safe fallback.
 */
export function safeRedirectPath(path?: string | null): string {
  if (
    !path ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    UNSAFE_PATH_CHARACTERS.test(path)
  ) {
    return "/";
  }

  try {
    const parsed = new URL(path, LOCAL_URL_BASE);
    if (parsed.origin !== LOCAL_URL_BASE) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export function buildSignInRedirectPath(path?: string | null): string {
  // URL fragments can contain E2E keys. They must never be copied into a
  // query parameter, because query strings are sent to the server and logs.
  const pathWithoutFragment = safeRedirectPath(path).split("#", 1)[0];
  return `${SIGN_IN_PATH}?redirect=${encodeURIComponent(pathWithoutFragment)}`;
}

export function buildExpiredSessionSignInPath(path?: string | null): string {
  return `${buildSignInRedirectPath(path)}&error=session-expired`;
}

export function shouldRequireClassicUploadAuthentication(
  isClassicUploadRoute: boolean,
  allowUnauthenticatedShares: boolean,
  sessionWasExpected: boolean,
): boolean {
  return (
    isClassicUploadRoute && (!allowUnauthenticatedShares || sessionWasExpected)
  );
}

export function isTeamRoutePath(pathname?: string | null): boolean {
  return pathname === "/team" || Boolean(pathname?.startsWith("/team/"));
}

export function isEmailVerificationRoutePath(
  pathname?: string | null,
): boolean {
  return pathname === "/auth/verify-email";
}

export function isTeamInvitationRoutePath(pathname?: string | null): boolean {
  return Boolean(pathname?.startsWith("/team/invite/"));
}

export function isTeamScopedUploadPath(path?: string | null): boolean {
  const safePath = safeRedirectPath(path);
  const parsed = new URL(safePath, LOCAL_URL_BASE);
  return (
    parsed.pathname === "/upload" &&
    (parsed.searchParams.has("teamFolderId") ||
      parsed.searchParams.has("teamId"))
  );
}

export function isProtectedTeamContextPath(path?: string | null): boolean {
  const safePath = safeRedirectPath(path);
  const pathname = new URL(safePath, LOCAL_URL_BASE).pathname;
  return isTeamRoutePath(pathname) || isTeamScopedUploadPath(safePath);
}

export function notifyAuthSessionExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
}

type StoredPostAuthTarget = {
  path: string;
  fragment?: string;
  createdAt: number;
};

function readStoredPostAuthTarget(): StoredPostAuthTarget | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(POST_AUTH_TARGET_STORAGE_KEY);
    if (!raw) return null;

    const stored = JSON.parse(raw) as Partial<StoredPostAuthTarget>;
    const safePath = safeRedirectPath(stored.path);
    const createdAt = stored.createdAt;
    const fragmentIsSafe =
      stored.fragment === undefined ||
      (typeof stored.fragment === "string" &&
        TEAM_KEY_FRAGMENT.test(stored.fragment));

    if (
      safePath !== stored.path ||
      safePath.includes("#") ||
      typeof createdAt !== "number" ||
      Date.now() - createdAt > POST_AUTH_TARGET_TTL_MS ||
      !fragmentIsSafe
    ) {
      window.sessionStorage.removeItem(POST_AUTH_TARGET_STORAGE_KEY);
      return null;
    }

    return {
      path: safePath,
      fragment: stored.fragment,
      createdAt,
    };
  } catch {
    try {
      window.sessionStorage.removeItem(POST_AUTH_TARGET_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
    return null;
  }
}

/**
 * Keep a post-authentication target in per-tab browser storage.
 *
 * A strictly validated Team E2E key fragment is stored separately from the
 * sign-in URL, so it never crosses the network as a query parameter.
 */
export function rememberPostAuthRedirectTarget(path?: string | null): void {
  if (typeof window === "undefined") return;

  const safePath = safeRedirectPath(path);
  const fragmentIndex = safePath.indexOf("#");
  const pathWithoutFragment =
    fragmentIndex >= 0 ? safePath.slice(0, fragmentIndex) : safePath;
  const fragment =
    fragmentIndex >= 0 ? safePath.slice(fragmentIndex) : undefined;

  if (pathWithoutFragment === "/") return;

  const stored: StoredPostAuthTarget = {
    path: pathWithoutFragment,
    createdAt: Date.now(),
  };
  const targetPathname = new URL(pathWithoutFragment, LOCAL_URL_BASE).pathname;
  if (
    isTeamRoutePath(targetPathname) &&
    fragment &&
    TEAM_KEY_FRAGMENT.test(fragment)
  ) {
    stored.fragment = fragment;
  }

  try {
    window.sessionStorage.setItem(
      POST_AUTH_TARGET_STORAGE_KEY,
      JSON.stringify(stored),
    );
  } catch {
    // Storage may be disabled. The hashless redirect remains safe and usable.
  }
}

export function getRememberedPostAuthRedirectPath(): string | null {
  return readStoredPostAuthTarget()?.path ?? null;
}

export function finalizePostAuthRedirectPath(path: string): string {
  const safePath = safeRedirectPath(path);
  const pathWithoutFragment = safePath.split("#", 1)[0];
  const stored = readStoredPostAuthTarget();
  if (!stored || stored.path !== pathWithoutFragment) return safePath;

  try {
    window.sessionStorage.removeItem(POST_AUTH_TARGET_STORAGE_KEY);
  } catch {
    // Best effort. The TTL and exact-path check prevent unsafe reuse.
  }
  return `${pathWithoutFragment}${stored.fragment ?? ""}`;
}
