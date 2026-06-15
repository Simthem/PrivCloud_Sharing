const NATIVE_HOST = "fr.privcloud.companion";
const DEFAULT_APP_URL = "https://share.example.com";
const LOCAL_BRIDGE_URL = "http://127.0.0.1:47631/v1";

function runtimeApi() {
  return globalThis.browser || globalThis.chrome;
}

function promisify(callbackApi) {
  return new Promise((resolve) => callbackApi(resolve));
}

function sendNative(message) {
  const api = runtimeApi();
  return promisify((resolve) => {
    api.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      const lastError = api.runtime.lastError;
      if (lastError) {
        resolve({
          ok: false,
          error: {
            code: "native_unavailable",
            message: lastError.message,
          },
        });
        return;
      }
      resolve(response);
    });
  });
}

async function loopbackHealth() {
  try {
    const response = await fetch(`${LOCAL_BRIDGE_URL}/health`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function companionCommand(type, payload, origin) {
  const nativeResponse = await sendNative({
    id: crypto.randomUUID(),
    type,
    origin,
    payload,
  });
  if (nativeResponse?.ok) return nativeResponse.result;
  if (type === "health") {
    const fallback = await loopbackHealth();
    if (fallback) return fallback;
  }
  throw new Error(nativeResponse?.error?.message || "PrivCloud Companion is not available");
}

async function openPrivCloud(path = "/upload") {
  const api = runtimeApi();
  await api.tabs.create({ url: `${DEFAULT_APP_URL}${path}` });
}

runtimeApi().runtime.onMessage.addListener((message, sender, sendResponse) => {
  const origin = message?.origin || sender?.origin || sender?.url || DEFAULT_APP_URL;

  (async () => {
    if (message?.type === "privcloud.open") {
      await openPrivCloud(message.path);
      return { ok: true };
    }
    if (message?.type?.startsWith("privcloud.companion.")) {
      const command = message.type.replace("privcloud.companion.", "");
      return {
        ok: true,
        result: await companionCommand(command, message.payload || {}, origin),
      };
    }
    return { ok: false, error: "Unknown PrivCloud extension message" };
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
