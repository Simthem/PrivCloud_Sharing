const REQUEST_EVENT = "privcloud-companion-request";
const RESPONSE_EVENT = "privcloud-companion-response";

window.addEventListener(REQUEST_EVENT, (event) => {
  const detail = event.detail || {};
  if (!detail.id || typeof detail.type !== "string") return;

  chrome.runtime.sendMessage(
    {
      id: detail.id,
      type: detail.type,
      origin: window.location.origin,
      payload: detail.payload || {},
    },
    (response) => {
      window.dispatchEvent(
        new CustomEvent(RESPONSE_EVENT, {
          detail: {
            id: detail.id,
            response: response || {
              ok: false,
              error: chrome.runtime.lastError?.message || "No response",
            },
          },
        }),
      );
    },
  );
});

window.dispatchEvent(
  new CustomEvent("privcloud-companion-extension-ready", {
    detail: { version: chrome.runtime.getManifest().version },
  }),
);
