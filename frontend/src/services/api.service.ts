import axios from "axios";
import {
  isUploadActive,
  isUploadCoolingDown,
  setUploadActive,
} from "./upload-state.service";
import {
  buildSignInRedirectPath,
  isProtectedTeamContextPath,
  rememberPostAuthRedirectTarget,
} from "../utils/authRedirect.util";
import {
  AuthRefreshResult,
  refreshAfterPossibleCookieRotation,
} from "../utils/authRefresh.util";

const api = axios.create({
  baseURL: "/api",
});

export { isUploadActive, setUploadActive };

// Guard against SafeLine reload loops on non-upload pages.
let _lastSafelineReload = 0;
const SAFELINE_RELOAD_COOLDOWN_MS = 30_000; // 30s between reloads

// --- SafeLine 468 challenge -------------------------------------------------
// SafeLine WAF returns 468 when an anti-bot challenge is required.
// The challenge is a JavaScript verification that sets a session cookie.
// Strategy (ordered by reliability):
//   1. IFRAME (invisible): Create a hidden iframe to '/'. SafeLine
//      intercepts and serves its JS challenge. The JS executes
//      automatically (no user gesture needed), sets the cookie, and
//      redirects to our app. We detect completion by polling
//      validateSafeLineSession(). This is the PRIMARY method because
//      it works 100% of the time without user interaction.
//   2. POPUP (fallback): If iframe fails after 30s (e.g. X-Frame-Options
//      or network issue), try a popup. May be blocked by the browser
//      if no recent user gesture.
//   3. NOTIFICATION (last resort): Show a clickable notification so the
//      user can manually trigger the popup with a click (user gesture).
let safelineChallengeInFlight: Promise<void> | null = null;
const SAFELINE_BROADCAST_CHANNEL = "safeline-challenge";

/**
 * Validate that the SafeLine session cookie is active by making a
 * lightweight fetch.  Returns true if the response is NOT 468.
 */
export async function validateSafeLineSession(): Promise<boolean> {
  try {
    const resp = await fetch("/?_sl_validate=" + Date.now(), {
      credentials: "include",
      cache: "no-store",
      mode: "same-origin",
    });
    const valid = resp.status !== 468;
    resp.body?.cancel();
    return valid;
  } catch {
    // Network error - assume session is valid (don't block on transient issues)
    return true;
  }
}

/**
 * Attempt to solve SafeLine challenge via a hidden iframe.
 * The iframe loads '/', SafeLine intercepts with its JS challenge,
 * the challenge executes and sets the session cookie.
 * We poll validateSafeLineSession() until it passes.
 * Returns true if solved, false if timed out.
 */
async function resolveChallengeViaIframe(timeoutMs = 45_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:none;";
    iframe.src = "/?_sl_iframe=" + Date.now();
    // No sandbox: SafeLine's challenge JS may need full capabilities
    // (navigation, form submission, cookie access). Since we load our
    // own origin, this is safe.

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let hardTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      try {
        iframe.remove();
      } catch {
        /* */
      }
    };

    // Poll every 2s to see if the cookie is now valid
    const startTime = Date.now();
    pollTimer = setInterval(async () => {
      // Don't poll until at least 3s have passed (give iframe time to load)
      if (Date.now() - startTime < 3000) return;
      try {
        const valid = await validateSafeLineSession();
        if (valid) {
          cleanup();
          resolve(true);
        }
      } catch {
        /* ignore poll errors */
      }
    }, 2000);

    // Hard timeout
    hardTimeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    // Also listen for BroadcastChannel signal (if _app.tsx loads in iframe)
    try {
      const bc = new BroadcastChannel(SAFELINE_BROADCAST_CHANNEL);
      bc.onmessage = (e) => {
        if (e.data?.type === "safeline-challenge-complete") {
          bc.close();
          // Give 1s for cookie to propagate
          setTimeout(async () => {
            cleanup();
            resolve(true);
          }, 1000);
        }
      };
      // Close BC on timeout
      setTimeout(() => {
        try {
          bc.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    } catch {
      /* BC not supported */
    }

    document.body.appendChild(iframe);
  });
}

const completeSafeLineChallenge = (): Promise<void> => {
  if (safelineChallengeInFlight) return safelineChallengeInFlight;

  safelineChallengeInFlight = (async () => {
    // --- Layer 1: Invisible iframe (no user gesture needed) ---
    try {
      const iframeOk = await resolveChallengeViaIframe(45_000);
      if (iframeOk) {
        safelineChallengeInFlight = null;
        return;
      }
    } catch {
      // iframe failed - continue to popup
    }

    // --- Layer 2: Popup (needs user gesture OR permissive browser settings) ---
    try {
      await new Promise<void>((resolve, reject) => {
        const popup = window.open(
          window.location.origin + "/",
          "safeline_challenge",
          "popup,width=900,height=650,left=200,top=100",
        );

        if (!popup) {
          reject(new Error("popup-blocked"));
          return;
        }

        let bc: BroadcastChannel | null = null;
        let pollClosed: ReturnType<typeof setInterval> | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let resolved = false;

        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          if (timeout !== null) clearTimeout(timeout);
          if (pollClosed !== null) clearInterval(pollClosed);
          if (bc) {
            bc.close();
            bc = null;
          }
          window.removeEventListener("message", onLegacyMessage);
          try {
            popup.close();
          } catch {
            /* already closed */
          }
        };

        const onChallengeSignal = () => {
          if (resolved) return;
          cleanup();
          resolve();
        };

        try {
          bc = new BroadcastChannel(SAFELINE_BROADCAST_CHANNEL);
          bc.onmessage = (e) => {
            if (e.data?.type === "safeline-challenge-complete") {
              onChallengeSignal();
            }
          };
        } catch {
          /* BC not supported */
        }

        const onLegacyMessage = (e: MessageEvent) => {
          if (e.origin !== window.location.origin) return;
          if (e.data?.type === "safeline-challenge-complete") {
            onChallengeSignal();
          }
        };
        window.addEventListener("message", onLegacyMessage);

        pollClosed = setInterval(() => {
          if (popup.closed) onChallengeSignal();
        }, 800);

        timeout = setTimeout(() => {
          cleanup();
          reject(new Error("SafeLine challenge timeout"));
        }, 120_000);
      });
      safelineChallengeInFlight = null;
      return;
    } catch {
      // popup also failed
    }

    // --- Layer 3: Reject (caller will show notification to user) ---
    safelineChallengeInFlight = null;
    throw new Error("popup-blocked");
  })();

  return safelineChallengeInFlight;
};

// Exported so the upload page can attempt the iframe challenge from
// its own 468 handler (fetch bypasses axios interceptors).
export { completeSafeLineChallenge };

// --- Dedicated axios instance for token refresh -----------------------------
// Uses ONLY the SafeLine 468 interceptor so the refresh call can solve a
// challenge transparently.  Does NOT have the 401/403 interceptor to
// avoid infinite recursion (refresh getting 401 -> try refresh -> ...).
const refreshApi = axios.create({});

refreshApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 468 && !original._safelineRetried) {
      original._safelineRetried = true;
      // During upload: popup challenge (Worker may need cookie set).
      if (isUploadActive()) {
        try {
          await completeSafeLineChallenge();
          return refreshApi(original);
        } catch {
          // popup failed -- fall through to reject
        }
      } else {
        // Non-upload: silent page reload triggers SafeLine challenge
        // naturally as a normal page load.
        const now = Date.now();
        if (now - _lastSafelineReload > SAFELINE_RELOAD_COOLDOWN_MS) {
          _lastSafelineReload = now;
          window.location.reload();
          return new Promise(() => {}); // never resolves (page reloading)
        }
      }
    }
    return Promise.reject(error);
  },
);

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

  refreshInFlight = refreshAfterPossibleCookieRotation(attempt)
    .finally(() => {
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
  (response) => response,
  async (error) => {
    const original = error.config;

    // SafeLine anti-bot challenge
    if (error.response?.status === 468) {
      // During upload: skip -- the chunk upload Worker handles 468
      // with its own retry loop and user-visible notification.
      if (isUploadActive()) {
        return Promise.reject(error);
      }

      // Non-upload requests: trigger a page reload so SafeLine serves
      // its challenge as a normal page load (transparent to the user).
      // A 30s cooldown prevents reload loops if the user is truly
      // rate-limited/banned.
      if (!original._safelineRetried) {
        original._safelineRetried = true;
        const now = Date.now();
        if (now - _lastSafelineReload > SAFELINE_RELOAD_COOLDOWN_MS) {
          _lastSafelineReload = now;
          window.location.reload();
          return new Promise(() => {}); // never resolves (page reloading)
        }
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

    const uploadActive = isUploadActive();
    const needsRefresh = uploadActive
      ? error.response?.status === 401
      : (error.response?.status === 401 || error.response?.status === 403) &&
        !isShareSecurityError;

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
          const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          rememberPostAuthRedirectTarget(returnPath);
          window.location.href = buildSignInRedirectPath(returnPath);
          return new Promise(() => {});
        }
        return Promise.reject(error);
      }

      return api(original);
    }
    return Promise.reject(error);
  },
);

export default api;
