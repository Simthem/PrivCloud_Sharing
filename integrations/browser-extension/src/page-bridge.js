const REQUEST_EVENT = "privcloud-companion-request";
const RESPONSE_EVENT = "privcloud-companion-response";

window.addEventListener(REQUEST_EVENT, (event) => {
  const detail = event.detail || {};
  if (
    typeof detail.id !== "string" ||
    detail.id.length > 80 ||
    typeof detail.type !== "string" ||
    detail.type.length > 80
  )
    return;

  chrome.runtime.sendMessage(
    {
      id: detail.id,
      type: detail.type,
      payload: detail.payload || {},
    },
    (response) => {
      void chrome.runtime.lastError;
      window.dispatchEvent(
        new CustomEvent(RESPONSE_EVENT, {
          detail: {
            id: detail.id,
            response: response || {
              ok: false,
              error: "bridge.error.unavailable",
            },
          },
        }),
      );
    },
  );
});

window.dispatchEvent(
  new CustomEvent("privcloud-companion-extension-ready", {
    detail: {
      version: chrome.runtime.getManifest().version,
      nativeTransportVersion: 1,
    },
  }),
);
