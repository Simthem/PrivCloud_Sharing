import { BridgeHealth } from "./privcloudBridge.service";

const REQUEST_EVENT = "privcloud-companion-request";
const RESPONSE_EVENT = "privcloud-companion-response";
const EXTENSION_READY_EVENT = "privcloud-companion-extension-ready";
const REQUEST_TIMEOUT_MS = 2500;

export type CompanionExtensionState = {
  installed: boolean;
  version?: string;
  health?: BridgeHealth;
};

type ExtensionResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

function requestFromExtensionRaw(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<ExtensionResponse | null> {
  if (typeof window === "undefined") return Promise.resolve(null);

  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener(RESPONSE_EVENT, onResponse as EventListener);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);

    const onResponse = (event: CustomEvent) => {
      if (event.detail?.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener(RESPONSE_EVENT, onResponse as EventListener);
      resolve(event.detail.response ?? { ok: false });
    };

    window.addEventListener(RESPONSE_EVENT, onResponse as EventListener);
    window.dispatchEvent(
      new CustomEvent(REQUEST_EVENT, {
        detail: {
          id,
          type,
          payload,
        },
      }),
    );
  });
}

function requestFromExtension<T>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T | null> {
  return requestFromExtensionRaw(type, payload).then((r) =>
    r?.ok ? (r.result as T) : null,
  );
}

export function onCompanionExtensionReady(
  callback: (_version?: string) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: CustomEvent) => callback(event.detail?.version);
  window.addEventListener(EXTENSION_READY_EVENT, handler as EventListener);
  return () =>
    window.removeEventListener(EXTENSION_READY_EVENT, handler as EventListener);
}

export async function getCompanionExtensionState(): Promise<CompanionExtensionState> {
  // Use a lightweight ping to check if the extension is installed.
  // The extension replies even if the companion isn't running.
  const response = await requestFromExtensionRaw(
    "privcloud.companion.health",
  );
  // response === null -> no extension (timeout), otherwise extension answered
  if (response === null) return { installed: false };
  // Extension is installed regardless of companion status
  const health = response.ok ? (response.result as BridgeHealth) : undefined;
  return {
    installed: true,
    version: health?.version,
    health: health ?? undefined,
  };
}

export async function openPrivCloudFromExtension(path = "/upload") {
  return requestFromExtension("privcloud.open", { path });
}
