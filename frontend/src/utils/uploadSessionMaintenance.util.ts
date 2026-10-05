import { scheduleUploadInterval } from "./uploadClock.util";
import {
  probeSafeLineSession,
  type SafeLineSessionStatus,
} from "./safelineChallenge.util";

type MaintenanceOptions = {
  isActive: () => boolean;
  heartbeat: () => Promise<unknown>;
  resolveChallenge: () => Promise<void>;
  probeSession?: () => Promise<SafeLineSessionStatus>;
};

/** Retain the upload tab and its session while bytes or finalization are pending. */
export function startUploadSessionMaintenance({
  isActive,
  heartbeat,
  resolveChallenge,
  probeSession = () => probeSafeLineSession(true),
}: MaintenanceOptions): () => void {
  let stopped = false;
  let checking = false;
  let lastHeartbeatAt = 0;
  const maintain = async () => {
    if (stopped || checking || !isActive()) return;
    checking = true;
    try {
      const status = await probeSession();
      if (stopped || !isActive()) return;
      if (status === "unavailable") return;
      if (status === "challenge") {
        await resolveChallenge();
        if (stopped || !isActive()) return;
      }
      if (Date.now() - lastHeartbeatAt >= 2 * 60_000) {
        // The API interceptor also renews an expired authentication session.
        await heartbeat();
        lastHeartbeatAt = Date.now();
      }
    } catch {
      // Keep the session guard and retry on the next timer or wake-up event.
    } finally {
      checking = false;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void maintain();
  };
  const onResume = () => void maintain();
  const interval = scheduleUploadInterval(() => void maintain(), 30_000);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onResume);
  window.addEventListener("pageshow", onResume);
  window.addEventListener("focus", onResume);
  void maintain();
  return () => {
    if (stopped) return;
    stopped = true;
    interval();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onResume);
    window.removeEventListener("pageshow", onResume);
    window.removeEventListener("focus", onResume);
  };
}
