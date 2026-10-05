import { scheduleUploadInterval, scheduleUploadTimeout } from "./uploadClock.util";

const CHANNEL = "safeline-challenge";
const COMPLETE = "safeline-challenge-complete";
let challengeInFlight: Promise<void> | null = null;
let userChallengeInFlight: Promise<void> | null = null;
let popupNeedsUserGesture = false;

/** A challenge HTML page or a network failure cannot confirm an API session. */
export type SafeLineSessionStatus = "valid" | "challenge" | "unavailable";

export async function probeSafeLineSession(
  checkPage = false,
): Promise<SafeLineSessionStatus> {
  const controller = new AbortController();
  const timeout = scheduleUploadTimeout(() => controller.abort(), 10_000);
  try {
    if (checkPage) {
      // Maintain the document route too: a proxy can apply different WAF rules
      // to API and page requests. A successful API alone is then insufficient.
      const page = await fetch(`/?_sl_validate=${Date.now()}`, {
        credentials: "include",
        cache: "no-store",
        mode: "same-origin",
        signal: controller.signal,
      });
      // Drain the response so the proxy sees a completed request. Cancelling
      // after headers generated broken pipes on every maintenance probe.
      await page.arrayBuffer();
      if (page.status === 468 ||
          ([401, 403].includes(page.status) && (page.headers.get("content-type") || "").toLowerCase().includes("text/html"))) return "challenge";
      if (!page.ok) return "unavailable";
    }
    const response = await fetch(`/api/configs?_sl_validate=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      mode: "same-origin",
      signal: controller.signal,
    });
    const valid =
      response.ok &&
      (response.headers.get("content-type") || "")
        .toLowerCase()
        .includes("application/json");
    await response.arrayBuffer();
    if (response.status === 468 || (response.ok && !valid) ||
        ([401, 403].includes(response.status) && (response.headers.get("content-type") || "").toLowerCase().includes("text/html"))) return "challenge";
    if (valid && checkPage) popupNeedsUserGesture = false;
    return valid ? "valid" : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    timeout();
  }
}

export async function validateSafeLineSession(): Promise<boolean> {
  return (await probeSafeLineSession(true)) === "valid";
}

/** Signals only trigger verification. They never authorize resuming an upload. */
function waitForSession(
  timeoutMs: number,
  remove: () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let checking = false;
    let channel: BroadcastChannel | undefined;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      poll();
      timeout();
      window.removeEventListener("message", onMessage);
      channel?.close();
      remove();
      resolve(valid);
    };
    const verify = async () => {
      if (settled || checking) return;
      checking = true;
      const valid = await validateSafeLineSession();
      checking = false;
      if (valid) finish(true);
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.data?.type === COMPLETE
      ) {
        void verify();
      }
    };
    window.addEventListener("message", onMessage);
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => {
        if (event.data?.type === COMPLETE) void verify();
      };
    } catch {
      /* Polling also works without BroadcastChannel. */
    }
    const poll = scheduleUploadInterval(() => void verify(), 2_000);
    const timeout = scheduleUploadTimeout(() => finish(false), timeoutMs);
  });
}

export async function resolveChallengeViaIframe(
  timeoutMs = 45_000,
): Promise<boolean> {
  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:none;";
  // Permit challenge scripts and same-origin cookies, but never navigation
  // of the upload tab. This frame only loads the trusted application origin.
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  iframe.src = `/?_sl_iframe=${Date.now()}`;
  const waiting = waitForSession(timeoutMs, () => iframe.remove());
  document.body.appendChild(iframe);
  return waiting;
}

export async function resolveChallengeViaPopup(
  timeoutMs = 120_000,
): Promise<void> {
  const popup = window.open(
    "about:blank",
    "safeline_challenge",
    "popup,width=900,height=650,left=200,top=100",
  );
  if (!popup) {
    popupNeedsUserGesture = true;
    throw new Error("popup-blocked");
  }
  const waiting = waitForSession(timeoutMs, () => {
    try {
      popup.close();
    } catch {
      /* The popup may already be closed. */
    }
  });
  try {
    // Mark the blank same-origin window before the WAF or COOP severs opener.
    try {
      popup.sessionStorage.setItem("__sl_challenge", "1");
    } catch {
      /* URL marker is the fallback. */
    }
    popup.opener = null;
    popup.location.replace(`${window.location.origin}/?_sl_popup=1`);
  } catch {
    try {
      popup.close();
    } catch {
      /* Best effort. */
    }
  }
  // Closing a window is not evidence of a solved challenge. Poll the API even
  // if COOP marks the WindowProxy closed while the actual popup remains open.
  if (!(await waiting)) throw new Error("SafeLine challenge timeout");
  popupNeedsUserGesture = false;
}

function resolveChallengeFromUserGesture(): Promise<void> {
  if (!userChallengeInFlight) {
    const popup = resolveChallengeViaPopup().finally(() => {
      userChallengeInFlight = null;
      if (challengeInFlight === popup) challengeInFlight = null;
    });
    userChallengeInFlight = popup;
  }
  if (!challengeInFlight) challengeInFlight = userChallengeInFlight;
  return userChallengeInFlight;
}

/** Call directly from retry buttons, before any network or wake-lock await. */
export function prepareSafeLineRetry(): Promise<void> {
  return popupNeedsUserGesture
    ? resolveChallengeFromUserGesture()
    : Promise.resolve();
}

export function completeSafeLineChallenge(): Promise<void> {
  // After a blocked popup, use a real retry click immediately. Awaiting the
  // iframe first would consume the browser's transient user activation.
  if (
    popupNeedsUserGesture &&
    typeof navigator !== "undefined" &&
    navigator.userActivation?.isActive
  ) {
    return resolveChallengeFromUserGesture();
  }
  if (!challengeInFlight) {
    challengeInFlight = (async () => {
      if (await resolveChallengeViaIframe()) return;
      await (userChallengeInFlight ?? resolveChallengeViaPopup());
    })().finally(() => {
      challengeInFlight = null;
    });
  }
  return challengeInFlight;
}

/** Only a marked challenge popup may signal success and close itself. */
export function handleSafeLineChallengeWindow(): () => void {
  let marked =
    new URLSearchParams(window.location.search).get("_sl_popup") === "1";
  try {
    marked ||= sessionStorage.getItem("__sl_challenge") === "1";
  } catch {
    /* Storage may be disabled. */
  }
  if (!marked) return () => {};
  let stopped = false;
  let checking = false;
  const verify = async () => {
    if (stopped || checking) return;
    checking = true;
    const valid = await validateSafeLineSession();
    checking = false;
    if (!valid || stopped) return;
    stopped = true;
    poll();
    timeout();
    try {
      sessionStorage.removeItem("__sl_challenge");
    } catch {
      /* Optional. */
    }
    try {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage({ type: COMPLETE });
      channel.close();
    } catch {
      /* The parent also polls the session. */
    }
    try {
      window.opener?.postMessage({ type: COMPLETE }, window.location.origin);
    } catch {
      /* COOP may sever opener. */
    }
    // Script-created windows may close themselves even with an isolated opener.
    if (window.top === window.self) window.close();
  };
  const poll = scheduleUploadInterval(() => void verify(), 2_000);
  const timeout = scheduleUploadTimeout(() => {
    stopped = true;
    poll();
  }, 120_000);
  void verify();
  return () => {
    stopped = true;
    poll();
    timeout();
  };
}
