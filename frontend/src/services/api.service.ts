import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

// SafeLine WAF returns 468 when an anti-bot challenge is required.
// XHR/fetch cannot render that challenge page.  Instead of immediately
// reloading (which kills any in-progress upload), we first attempt to
// complete the challenge inside a hidden iframe -- its JS will execute,
// set the SafeLine cookie, and then we can retry the original request.
// A full page reload is used only as a last resort.
let safeline468Reloading = false;
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

// Transparent token refresh: when any request gets a 401, try to
// refresh the access token via the refresh cookie and retry once.
// This closes the race window between cookie expiry and the periodic
// refresh interval, so the caller never sees the 401.
let refreshPromise: Promise<void> | null = null;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    // SafeLine anti-bot challenge -- try hidden iframe first, then
    // fall back to a full page reload only if the iframe approach fails.
    if (error.response?.status === 468) {
      if (!original._safelineRetried) {
        original._safelineRetried = true;
        try {
          await completeSafeLineChallenge();
          return api(original);
        } catch {
          // Hidden iframe did not solve the challenge
        }
      }
      // Last resort: full page reload (only once)
      if (!safeline468Reloading) {
        safeline468Reloading = true;
        window.location.reload();
        return new Promise(() => {});
      }
    }

    if (
      error.response?.status === 401 &&
      !original._retry &&
      original.url !== "/auth/token" &&
      original.url !== "/auth/signIn"
    ) {
      original._retry = true;

      // Coalesce concurrent refresh attempts into a single request
      if (!refreshPromise) {
        refreshPromise = axios
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
