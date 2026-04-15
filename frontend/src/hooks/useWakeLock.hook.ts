import { useCallback, useRef } from "react";

/**
 * Keeps the screen awake during long-running uploads via the
 * Screen Wake Lock API.  Falls back silently on unsupported browsers.
 */
const useWakeLock = () => {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

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
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      // Re-acquire when tab becomes visible again (OS may release it)
      wakeLockRef.current.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
      document.addEventListener("visibilitychange", handleVisibilityChange);
    } catch {
      // Wake Lock request failed (low battery, iframe restriction, etc.)
      // Do NOT register the visibilitychange listener -- it would
      // retry forever, leaking Promises on every tab focus/blur.
    }
  }, []);

  const release = useCallback(async () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    try {
      await wakeLockRef.current?.release();
    } catch {
      // Already released
    }
    wakeLockRef.current = null;
  }, []);

  const handleVisibilityChange = async () => {
    if (document.visibilityState === "visible" && !wakeLockRef.current) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        // Failed again -- unregister to stop retrying forever.
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    }
  };

  return { acquire, release };
};

export default useWakeLock;
