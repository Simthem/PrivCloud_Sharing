import {
  completeSafeLineChallenge,
  validateSafeLineSession,
} from "../utils/safelineChallenge.util";
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import {
  isUploadActive,
  isUploadCoolingDown,
  setUploadActive,
} from "./upload-state.service";
import {
  buildExpiredSessionSignInPath,
  isProtectedTeamContextPath,
  notifyAuthSessionExpired,
  rememberPostAuthRedirectTarget,
} from "../utils/authRedirect.util";
import {
  type AuthRefreshResult,
  isReauthenticationRefusal,
  refreshAfterPossibleCookieRotation,
} from "../utils/authRefresh.util";
import { readStepUpScope, requestStepUp } from "../utils/stepUp.util";

const api = axios.create({
  baseURL: "/api",
});

export { isUploadActive, setUploadActive };

// The API and upload workers share one verified browser challenge flow.
export { completeSafeLineChallenge, validateSafeLineSession };

// --- Dedicated axios instance for token refresh -----------------------------
// Verifies WAF challenges without invoking account-token renewal recursively.
// JSON authentication failures propagate to the shared refresh coordinator.
const refreshApi = axios.create({});

async function verifyApiResponse(
  response: AxiosResponse,
  client: AxiosInstance,
): Promise<AxiosResponse> {
  const contentType = String(
    response.headers["content-type"] || "",
  ).toLowerCase();
  if (!contentType.includes("text/html") || typeof response.data !== "string")
    return response;
  const original = response.config as typeof response.config & {
    _safelineRetried?: boolean;
  };
  const challengeError = new axios.AxiosError(
    "WAF session verification is required",
    "ERR_BAD_RESPONSE",
    original,
    undefined,
    { ...response, status: 468 },
  );
  if (!original._safelineRetried) {
    original._safelineRetried = true;
    try {
      await completeSafeLineChallenge();
    } catch {
      // Preserve the page and report an unresolved challenge to the caller.
      throw challengeError;
    }
    return client(original);
  }
  throw challengeError;
}

refreshApi.interceptors.response.use(
  (response) => verifyApiResponse(response, refreshApi),
  async (error) => {
    const original = error.config;

    const response = error.response;
    if (
      response &&
      [401, 403].includes(response.status) &&
      typeof response.data === "string" &&
      String(response.headers?.["content-type"] || "")
        .toLowerCase()
        .includes("text/html")
    ) {
      return verifyApiResponse(response, refreshApi);
    }

    if (
      error.response?.status === 403 &&
      error.response?.data?.error === "email_verification_required"
    ) {
      if (window.location.pathname !== "/auth/verify-email") {
        window.location.href = new URL(
          "/auth/verify-email",
          window.location.origin,
        ).toString();
        return new Promise(() => {});
      }
      return Promise.reject(error);
    }
    if (
      error.response?.status === 468 &&
      original &&
      !original._safelineRetried
    ) {
      original._safelineRetried = true;
      try {
        await completeSafeLineChallenge();
        return refreshApi(original);
      } catch {
        // A failed WAF verification preserves the page and authentication state.
      }
    }
    return Promise.reject(error);
  },
);

let sessionExpiryInFlight: Promise<void> | null = null;

/**
 * Ends a browser session only after the guarded refresh retry also returned
 * 401. The keepalive request removes the HttpOnly session cookies server-side;
 * the event releases React loading states immediately if navigation is delayed.
 */
export function expireConfirmedSession(): Promise<void> {
  if (sessionExpiryInFlight) return sessionExpiryInFlight;

  sessionExpiryInFlight = (async () => {
    if (typeof window === "undefined") return;

    const clearCookies = window
      .fetch("/api/auth/signOut", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      })
      .catch(() => undefined);
    await Promise.race([
      clearCookies,
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1_000)),
    ]);

    notifyAuthSessionExpired();

    if (window.location.pathname === "/auth/signIn") return;

    const returnPath = window.location.pathname.startsWith("/auth/")
      ? "/"
      : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (returnPath !== "/") rememberPostAuthRedirectTarget(returnPath);
    window.location.replace(buildExpiredSessionSignInPath(returnPath));
  })().finally(() => {
    sessionExpiryInFlight = null;
  });

  return sessionExpiryInFlight;
}

// --- Shared single-flight token refresh -------------------------------------
// EVERY browser-side refresher (this interceptor, auth.service, the upload
// keepalive + the worker's need-token-refresh handler) MUST go through this
// one function. The backend rotates the refresh_token on each call and rejects
// a replayed (already-rotated) token with a 401. If two refreshers fire
// concurrently they present the same old cookie and the loser gets a 401 that
// wrongly logs the user out. A single in-flight promise guarantees at most one
// rotation at a time. Backed by refreshApi so a SafeLine 468 during the
// refresh is still handled transparently.
let refreshInFlight: Promise<AuthRefreshResult> | null = null;

export function refreshTokenOnce(): Promise<AuthRefreshResult> {
  if (refreshInFlight) return refreshInFlight;

  const attempt = (): Promise<AuthRefreshResult> =>
    refreshApi
      .post("/api/auth/token")
      .then(() => ({ ok: true, status: 200 }))
      .catch((e: any) => ({ ok: false, status: e?.response?.status ?? 0 }));

  refreshInFlight = refreshAfterPossibleCookieRotation(attempt).finally(() => {
    // Hold the slot ~300 ms after completion so a burst of near-simultaneous
    // callers reuse the same result instead of firing a second rotation.
    setTimeout(() => {
      refreshInFlight = null;
    }, 300);
  });
  return refreshInFlight;
}

// --- Main API interceptor ---------------------------------------------------
// Transparent token refresh: when any request gets a 401, try to
// refresh the access token via the refresh cookie and retry once.
// This closes the race window between cookie expiry and the periodic
// refresh interval, so the caller never sees the 401.
api.interceptors.response.use(
  (response) => verifyApiResponse(response, api),
  async (error) => {
    const original = error.config;

    const response = error.response;
    if (
      response &&
      [401, 403].includes(response.status) &&
      typeof response.data === "string" &&
      String(response.headers?.["content-type"] || "")
        .toLowerCase()
        .includes("text/html")
    ) {
      return verifyApiResponse(response, api);
    }

    if (
      error.response?.status === 403 &&
      error.response?.data?.error === "email_verification_required"
    ) {
      if (window.location.pathname !== "/auth/verify-email") {
        window.location.href = new URL(
          "/auth/verify-email",
          window.location.origin,
        ).toString();
        return new Promise(() => {});
      }
      return Promise.reject(error);
    }

    // Resolve 468 inside a separate browser context and replay the request.
    // Control-plane requests need recovery even while direct S3 PUTs continue.
    if (error.response?.status === 468) {
      if (original && !original._safelineRetried) {
        original._safelineRetried = true;
        try {
          await completeSafeLineChallenge();
          return api(original);
        } catch {
          /* Preserve the upload and propagate the original 468. */
        }
      }
      return Promise.reject(error);
    }

    // A sensitive operation: once the user confirmed their identity, the
    // request is replayed with that confirmation.
    const stepUpScope = readStepUpScope(error);
    if (stepUpScope) {
      if (original && !original._stepUp) {
        original._stepUp = true;
        if (await requestStepUp(stepUpScope)) return api(original);
      }
      return Promise.reject(error);
    }

    // During upload: only treat 401 as auth-expired (triggers refresh).
    // 403 can come from SafeLine rate-limiting or an application authorization
    // decision. Refreshing the token is wasteful and adds latency. Let the
    // chunk retry logic handle transient 403s with its own exponential backoff.
    //
    // Share security errors (password required, token required, etc.) are
    // legitimate 403s that must reach the share page handler.  Without
    // this exclusion the interceptor redirects anonymous visitors to
    // /auth/signIn before the share page can display its own UI.
    const shareSecurityErrors = [
      "share_token_required",
      "share_password_required",
      "private_share",
      "share_max_views_exceeded",
    ];
    const isShareSecurityError =
      error.response?.status === 403 &&
      shareSecurityErrors.includes(error.response?.data?.error);
    const refusedProof = isReauthenticationRefusal(
      error.response?.status,
      original?.url,
    );

    const uploadActive = isUploadActive();
    const needsRefresh = uploadActive
      ? error.response?.status === 401
      : (error.response?.status === 401 || error.response?.status === 403) &&
        !isShareSecurityError &&
        !refusedProof;

    if (
      needsRefresh &&
      !original._retry &&
      !original.url?.includes("auth/token") &&
      !original.url?.includes("auth/signIn")
    ) {
      original._retry = true;

      // Route through the shared single-flight refresher so this interceptor
      // never races the upload keepalive / auth.service on the token rotation.
      const result = await refreshTokenOnce();
      if (!result.ok) {
        // During upload: reject the error so the upload retry / abort
        // logic handles it gracefully instead of navigating away.
        if (uploadActive) {
          return Promise.reject(error);
        }
        // Right after an upload, SafeLine may still be penalizing us.
        // Don't redirect during the cooldown window -- the periodic
        // refresh will pick it up later once the ban lifts. Team pages are
        // protected more strictly: a confirmed 401 must leave them immediately.
        if (
          isUploadCoolingDown() &&
          !isProtectedTeamContextPath(
            `${window.location.pathname}${window.location.search}`,
          )
        ) {
          return Promise.reject(error);
        }
        // Only redirect to sign-in when the backend confirms the
        // refresh token is invalid/expired. Transient failures
        // (SafeLine 468, network wake-up glitches) should propagate
        // so the periodic refresh in _app.tsx can recover later.
        if (result.status === 401) {
          await expireConfirmedSession();
          return Promise.reject(error);
        }
        return Promise.reject(error);
      }

      return api(original);
    }
    return Promise.reject(error);
  },
);

export default api;
