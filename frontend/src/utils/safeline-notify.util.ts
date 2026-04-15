// Cross-tab SafeLine 468 challenge notification (Notification API + audio beep).
// Mantine showNotification is invisible when the tab is in the background.
// The browser Notification API shows an OS-level popup even if the tab is hidden,
// and the AudioContext beep is audible regardless of focus.

import { translateOutsideContext } from "../hooks/useTranslate.hook";

let _permissionGranted = false;

/**
 * Request browser notification permission.
 * Call early (e.g. at upload start) -- some browsers require a user gesture.
 * Safe to call multiple times; only the first effective call matters.
 */
export async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    _permissionGranted = true;
    return;
  }
  if (Notification.permission === "denied") return;
  try {
    const result = await Notification.requestPermission();
    _permissionGranted = result === "granted";
  } catch {
    // Old Safari callback API -- ignore
  }
}

/**
 * Play a short audible beep via AudioContext.
 * Works even when the tab is in the background (unlike <audio> on some browsers).
 */
function playBeep(): void {
  try {
    const ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880; // A5
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    // Three short beeps
    setTimeout(() => {
      try {
        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.connect(g2);
        g2.connect(ctx.destination);
        osc2.frequency.value = 880;
        g2.gain.value = 0.3;
        osc2.start();
        osc2.stop(ctx.currentTime + 0.25);
      } catch { /* ignore */ }
    }, 400);
    setTimeout(() => {
      try {
        const osc3 = ctx.createOscillator();
        const g3 = ctx.createGain();
        osc3.connect(g3);
        g3.connect(ctx.destination);
        osc3.frequency.value = 880;
        g3.gain.value = 0.3;
        osc3.start();
        osc3.stop(ctx.currentTime + 0.25);
        // Close context after last beep
        setTimeout(() => ctx.close().catch(() => {}), 500);
      } catch { /* ignore */ }
    }, 800);
  } catch {
    // AudioContext not available -- silent fail
  }
}

// Throttle: don't spam notifications (at most once per 30s)
let _lastNotifyAt = 0;
const NOTIFY_THROTTLE_MS = 30_000;

/**
 * Fire a cross-tab alert for SafeLine 468 challenges.
 * - OS-level Notification (visible even when tab is hidden)
 * - Audio beep (audible even in background)
 * - Title flash (catches the eye in the tab bar)
 */
export function notifySafeLineChallenge(): void {
  const now = Date.now();
  if (now - _lastNotifyAt < NOTIFY_THROTTLE_MS) return;
  _lastNotifyAt = now;

  // Audio beep
  playBeep();

  // OS-level notification
  if (_permissionGranted && typeof Notification !== "undefined") {
    const t = translateOutsideContext();
    try {
      const n = new Notification(t("safeline.os-notify.title"), {
        body: t("safeline.os-notify.body"),
        icon: "/img/logo.png",
        requireInteraction: true,
        tag: "safeline-468", // replaces previous instance
      });
      // Click -> focus our tab
      n.onclick = () => {
        window.focus();
        n.close();
      };
      // Auto-close after 60s
      setTimeout(() => n.close(), 60_000);
    } catch {
      // Notification blocked or unavailable -- audio beep was still played
    }
  }

  // Title flash: alternate the document title so the browser tab blinks.
  // Stops after 60s or when the user focuses the tab.
  if (document.hidden) {
    const originalTitle = document.title;
    const t = translateOutsideContext();
    const flashTitle = t("safeline.title-flash");
    let flashing = true;
    const interval = setInterval(() => {
      document.title =
        document.title === flashTitle ? originalTitle : flashTitle;
    }, 1000);
    const stop = () => {
      if (!flashing) return;
      flashing = false;
      clearInterval(interval);
      document.title = originalTitle;
    };
    window.addEventListener("focus", stop, { once: true });
    setTimeout(stop, 60_000);
  }
}
