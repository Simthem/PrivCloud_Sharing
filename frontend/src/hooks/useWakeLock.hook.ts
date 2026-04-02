import { useCallback, useRef } from "react";

/**
 * Keeps the screen awake during long-running uploads via the
 * Screen Wake Lock API.  Falls back silently on unsupported browsers.
 */
const useWakeLock = () => {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const acquire = useCallback(async () => {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      // Re-acquire when tab becomes visible again (OS may release it)
      wakeLockRef.current.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
      document.addEventListener("visibilitychange", handleVisibilityChange);
    } catch {
      // Wake Lock request can fail (e.g. low battery mode) - non-critical
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
        // Non-critical
      }
    }
  };

  return { acquire, release };
};

export default useWakeLock;
