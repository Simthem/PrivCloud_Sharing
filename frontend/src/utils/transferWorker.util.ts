import { scheduleUploadTimeout } from "./uploadClock.util";

// A worker URL claimed here runs under transfer-sw.js, which has no fetch
// handler, so its uploads never pass through sw.js.
const CLAIM_TIMEOUT_MS = 3000;
const claims = new Map<string, Promise<void>>();

const whenActive = (registration: ServiceWorkerRegistration) =>
  new Promise<void>((resolve) => {
    const pending = registration.installing ?? registration.waiting;
    if (registration.active || !pending) {
      resolve();
      return;
    }
    pending.addEventListener("statechange", () => {
      if (pending.state === "activated" || pending.state === "redundant")
        resolve();
    });
  });

/** Never rejects. Without the claim the worker keeps the page's worker. */
export function claimTransferWorkerScope(scriptPath: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return Promise.resolve();
  let claim = claims.get(scriptPath);
  if (!claim) {
    claim = new Promise<void>((resolve) => {
      const cancel = scheduleUploadTimeout(resolve, CLAIM_TIMEOUT_MS);
      navigator.serviceWorker
        .register("/transfer-sw.js", {
          scope: scriptPath,
          updateViaCache: "none",
        })
        .then(whenActive)
        .catch(() => undefined)
        .finally(() => {
          cancel();
          resolve();
        });
    });
    claims.set(scriptPath, claim);
  }
  return claim;
}
