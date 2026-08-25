import { useCallback, useRef } from "react";

/**
 * Keeps the screen awake during long-running uploads via the
 * Screen Wake Lock API.  Falls back silently on unsupported browsers.
 *
 * The user agent releases the lock on its own every time the page stops being
 * visible -- switching apps, pulling down the notification shade, answering a
 * call -- and never restores it. Holding a lock across a long upload is
 * therefore not one request but a request plus an indefinite re-acquire loop,
 * which is what the visibilitychange handler below is for.
 */

/**
 * Consecutive failed re-acquisitions after which the handler unregisters.
 *
 * Not zero: a single failure is usually situational (the request landed while
 * the page was still transitioning, the device was momentarily in a state that
 * refuses locks) and giving up on the first one is what leaves a two-hour
 * upload with a screen that sleeps. Not unbounded either: each failure is a
 * rejected Promise created on every focus change, and on a genuinely
 * unsupported setup that accumulates for the whole session.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

const useWakeLock = () => {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Whether a transfer still wants the screen up. Distinguishes "the UA took
  // the lock away while we were hidden", which must be undone, from "the
  // upload ended", which must not be.
  const wantedRef = useRef(false);
  const failuresRef = useRef(0);
  // Stable identity for add/removeEventListener. A plain function declared in
  // the hook body is a new object on every render, so the handler removed on
  // release() would not be the one added by acquire().
  const handlerRef = useRef<(() => void) | null>(null);

  const held = () => {
    const sentinel = wakeLockRef.current;
    // `released` is the authority, not the ref: the UA can release a sentinel
    // without us learning of it if a listener was ever missed, and a stale
    // non-null ref is indistinguishable from a live lock by nullity alone.
    return sentinel !== null && !sentinel.released;
  };

  const requestLock = useCallback(async () => {
    if (!wantedRef.current || held()) return;
    // A request made while hidden is rejected by every implementation; skip it
    // rather than spend one of the failure budget on a certainty.
    if (document.visibilityState !== "visible") return;

    try {
      const sentinel = await navigator.wakeLock.request("screen");
      // Attached to EVERY sentinel, including re-acquired ones. Attaching it
      // only to the first meant that after one hide/show cycle the ref pointed
      // at a released sentinel forever, the next cycle found it non-null, and
      // the screen was never held again for the rest of the upload.
      sentinel.addEventListener("release", () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
      });
      wakeLockRef.current = sentinel;
      failuresRef.current = 0;

      // release() may have run while the request above was in flight.
      if (!wantedRef.current) {
        wakeLockRef.current = null;
        await sentinel.release().catch(() => undefined);
      }
    } catch {
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES && handlerRef.current) {
        document.removeEventListener("visibilitychange", handlerRef.current);
        handlerRef.current = null;
      }
    }
  }, []);

  const acquire = useCallback(async () => {
    if (!("wakeLock" in navigator)) return;
    // In an iframe, the Permissions-Policy may forbid screen-wake-lock.
    // Detect this early to avoid repeated failing requests on every
    // visibilitychange event (each creates a rejected Promise that
    // pressures the GC over very long uploads).
    try {
      const status = await navigator.permissions.query(
        { name: "screen-wake-lock" as PermissionName },
      );
      if (status.state === "denied") return;
    } catch {
      // permissions.query() may not support this name -- try anyway
    }

    wantedRef.current = true;
    failuresRef.current = 0;

    // Registered before the first request, not after a successful one: the
    // request can legitimately fail now and succeed on the next focus, and a
    // handler that is only installed on success never gets that chance.
    if (!handlerRef.current) {
      const handler = () => void requestLock();
      handlerRef.current = handler;
      document.addEventListener("visibilitychange", handler);
    }

    await requestLock();
  }, [requestLock]);

  const release = useCallback(async () => {
    wantedRef.current = false;
    if (handlerRef.current) {
      document.removeEventListener("visibilitychange", handlerRef.current);
      handlerRef.current = null;
    }
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    try {
      await sentinel?.release();
    } catch {
      // Already released
    }
  }, []);

  return { acquire, release };
};

export default useWakeLock;
