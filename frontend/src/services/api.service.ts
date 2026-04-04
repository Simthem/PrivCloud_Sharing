import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

// SafeLine WAF returns 468 when an anti-bot challenge is required.
// XHR/fetch cannot render that challenge page, so the only option is
// a full page reload so the browser navigates to the challenge and
// returns to the app once verified.  A small flag prevents infinite
// reload loops if SafeLine keeps returning 468.
let safeline468Reloading = false;

// Transparent token refresh: when any request gets a 401, try to
// refresh the access token via the refresh cookie and retry once.
// This closes the race window between cookie expiry and the periodic
// refresh interval, so the caller never sees the 401.
let refreshPromise: Promise<void> | null = null;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    // SafeLine anti-bot challenge -- reload the page so the browser
    // can complete the challenge natively.
    if (error.response?.status === 468 && !safeline468Reloading) {
      safeline468Reloading = true;
      window.location.reload();
      // Return a never-resolving promise so no further code runs
      // while the browser is navigating.
      return new Promise(() => {});
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
          .catch(() => {})
          .finally(() => {
            refreshPromise = null;
          });
      }
      await refreshPromise;

      return api(original);
    }
    return Promise.reject(error);
  },
);

export default api;
