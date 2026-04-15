import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

// --- Upload-active guard ---------------------------------------------------
// The upload page sets this flag while chunks are in flight.  While active
// the interceptor will NEVER redirect to /auth/signIn or trigger a full
// page reload -- both actions would kill the upload and lose progress.
let _uploadActive = false;
let _uploadEndedAt = 0;
const UPLOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after upload ends
export const setUploadActive = (active: boolean) => {
  _uploadActive = active;
  if (!active) _uploadEndedAt = Date.now();
};
export const isUploadActive = () => _uploadActive;

// --- SafeLine 468 challenge -------------------------------------------------
// SafeLine WAF returns 468 when an anti-bot challenge is required.
// XHR/fetch cannot render that challenge page.  We complete the
// challenge inside a hidden iframe -- its JS will execute, set the
// SafeLine cookie, and then we can retry the original request.
// We NEVER reload the page (it destroys upload progress and state).
let safelineChallengeInFlight: Promise<void> | null = null;

const completeSafeLineChallenge = (): Promise<void> => {
  if (safelineChallengeInFlight) return safelineChallengeInFlight;

  safelineChallengeInFlight = new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.top = "-9999px";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    // allow-scripts: challenge JS must execute to set the WAF cookie.
    // allow-same-origin: required so the cookie is set on the correct origin.
    // allow-top-navigation is intentionally OMITTED: prevents the challenge
    // page from navigating the main frame (which would kill any in-progress
    // upload and cause a white-screen crash).
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.src = window.location.origin + "/";

    const cleanup = () => {
      clearTimeout(timeout);
      if (iframe.parentNode) document.body.removeChild(iframe);
      safelineChallengeInFlight = null;
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SafeLine challenge timeout"));
    }, 15000);

    iframe.onload = () => {
      // Give the challenge JS time to execute and set the cookie
      setTimeout(() => {
        cleanup();
        resolve();
      }, 2500);
    };

    iframe.onerror = () => {
      cleanup();
      reject(new Error("SafeLine challenge iframe failed"));
    };

    document.body.appendChild(iframe);
  });

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
      try {
        await completeSafeLineChallenge();
        return refreshApi(original);
      } catch {
        // iframe challenge failed -- nothing more we can do for refresh
      }
    }
    return Promise.reject(error);
  },
);

// --- Main API interceptor ---------------------------------------------------
// Transparent token refresh: when any request gets a 401, try to
// refresh the access token via the refresh cookie and retry once.
// This closes the race window between cookie expiry and the periodic
// refresh interval, so the caller never sees the 401.
let refreshPromise: Promise<void> | null = null;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    // SafeLine anti-bot challenge
    if (error.response?.status === 468) {
      // During upload: skip the iframe challenge entirely -- it fails
      // with ERR_CERT_COMMON_NAME_INVALID on challenge.js and wastes
      // 15s per chunk retry.  The chunk upload loop handles 468 with
      // a user-visible notification and unlimited retries.
      if (_uploadActive) {
        return Promise.reject(error);
      }

      // Non-upload requests: try hidden iframe first
      if (!original._safelineRetried) {
        original._safelineRetried = true;
        try {
          await completeSafeLineChallenge();
          return api(original);
        } catch {
          // Hidden iframe did not solve the challenge
        }
      }
      // NEVER reload the page -- this destroys all state (upload
      // progress, forms, etc.) and if the user is rate-limited/banned
      // the reload just shows the block page anyway.  Instead, reject
      // the error and let the caller handle it.  The periodic refresh
      // in _app.tsx will silently retry later.
      return Promise.reject(error);
    }

    // During upload: only treat 401 as auth-expired (triggers refresh).
    // 403 can come from SafeLine rate-limiting or backend quota checks --
    // refreshing the token is wasteful and adds latency.  Let the chunk
    // retry logic handle transient 403s with its own exponential backoff.
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

    const needsRefresh = _uploadActive
      ? error.response?.status === 401
      : (error.response?.status === 401 || error.response?.status === 403) &&
        !isShareSecurityError;

    if (
      needsRefresh &&
      !original._retry &&
      original.url !== "/auth/token" &&
      original.url !== "/auth/signIn"
    ) {
      original._retry = true;

      // Coalesce concurrent refresh attempts into a single request.
      // Uses refreshApi (which has 468 handling but no 401/403 handler)
      // to avoid the infinite loop when SafeLine challenges the refresh
      // call itself.
      if (!refreshPromise) {
        refreshPromise = refreshApi
          .post("/api/auth/token")
          .then(() => {})
          .finally(() => {
            refreshPromise = null;
          });
      }

      try {
        await refreshPromise;
      } catch {
        // Refresh token is invalid or expired -- the session is dead.
        // During upload: reject the error so the upload retry / abort
        // logic handles it gracefully instead of navigating away.
        if (_uploadActive) {
          return Promise.reject(error);
        }
        // Right after an upload, SafeLine may still be penalizing us.
        // Don't redirect during the cooldown window -- the periodic
        // refresh will pick it up later once the ban lifts.
        if (Date.now() - _uploadEndedAt < UPLOAD_COOLDOWN_MS) {
          return Promise.reject(error);
        }
        // Hard-redirect to sign-in so the user can re-authenticate
        // instead of silently swallowing every subsequent 401.
        window.location.href = "/auth/signIn";
        return new Promise(() => {});
      }

      return api(original);
    }
    return Promise.reject(error);
  },
);

export default api;
