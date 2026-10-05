const NATIVE_HOST = "fr.privcloud.companion";
const DEFAULT_APP_URL = "https://share.example.com";
const COMMANDS = new Set([
  "health",
  "authorize",
  "webdav.list",
  "webdav.upload.start",
  "webdav.download.open",
  "webdav.download.read",
  "webdav.download.close",
  "jobs.get",
  "jobs.cancel",
]);
const ports = new Map();
const api = globalThis.browser || globalThis.chrome;

function allowedPageOrigin(sender) {
  if (sender.id !== api.runtime.id || sender.frameId !== 0 || !sender.tab)
    throw new Error("bridge.error.originDenied");
  const url = new URL(sender.url);
  if (sender.origin && sender.origin !== url.origin)
    throw new Error("bridge.error.originDenied");
  const matches = api.runtime.getManifest().content_scripts[0].matches;
  if (
    !matches.some((match) => new URL(match.slice(0, -1)).origin === url.origin)
  )
    throw new Error("bridge.error.originDenied");
  return url.origin;
}

function connection(origin) {
  if (ports.has(origin)) return ports.get(origin);
  if (ports.size >= 8) throw new Error("bridge.error.busy");
  const port = api.runtime.connectNative(NATIVE_HOST);
  const entry = { port, pending: new Map() };
  ports.set(origin, entry);
  port.onMessage.addListener((response) => {
    const request = entry.pending.get(response?.id);
    if (!request) return;
    entry.pending.delete(response.id);
    clearTimeout(request.timer);
    request.resolve(response);
  });
  port.onDisconnect.addListener(() => {
    // Consume lastError so Chromium does not log an unchecked runtime error.
    void api.runtime.lastError;
    ports.delete(origin);
    for (const request of entry.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("bridge.error.unavailable"));
    }
    entry.pending.clear();
  });
  return entry;
}

function sendNative(type, payload, origin) {
  const entry = connection(origin);
  if (entry.pending.size >= 16) throw new Error("bridge.error.busy");
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error("bridge.error.timeout"));
    }, 55_000);
    entry.pending.set(id, { resolve, reject, timer });
    try {
      entry.port.postMessage({ id, type, origin, payload });
    } catch {
      clearTimeout(timer);
      entry.pending.delete(id);
      reject(new Error("bridge.error.unavailable"));
    }
  });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (sender.id !== api.runtime.id)
      throw new Error("bridge.error.originDenied");
    if (message?.type === "privcloud.open") {
      const path = message.payload?.path ?? message.path ?? "/upload";
      const target = new URL(path, DEFAULT_APP_URL);
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        target.origin !== DEFAULT_APP_URL
      )
        throw new Error("bridge.error.badRequest");
      await api.tabs.create({ url: target.href });
      return { ok: true, result: true };
    }
    const popup =
      !sender.tab && sender.url === api.runtime.getURL("src/popup.html");
    const origin =
      popup && message?.type === "privcloud.companion.health"
        ? DEFAULT_APP_URL
        : allowedPageOrigin(sender);
    if (message?.type === "privcloud.companion.probe")
      return {
        ok: true,
        result: {
          version: api.runtime.getManifest().version,
          nativeTransportVersion: 1,
        },
      };
    const command = String(message?.type || "").replace(
      /^privcloud\.companion\./,
      "",
    );
    if (!COMMANDS.has(command)) throw new Error("bridge.error.badRequest");
    const payload = message.payload || {};
    if (
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      new TextEncoder().encode(JSON.stringify(payload)).length > 250 * 1024
    )
      throw new Error("bridge.error.messageTooLarge");
    return await sendNative(command, payload, origin);
  })()
    .then(sendResponse)
    .catch((error) => {
      const message = error.message.startsWith("bridge.error.")
        ? error.message
        : "bridge.error.unavailable";
      sendResponse({ ok: false, error: { message } });
    });
  return true;
});
