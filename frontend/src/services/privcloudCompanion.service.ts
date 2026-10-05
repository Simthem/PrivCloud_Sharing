import type { BridgeHealth } from "./privcloudBridge.service";

const REQUEST_EVENT = "privcloud-companion-request";
const RESPONSE_EVENT = "privcloud-companion-response";
const EXTENSION_READY_EVENT = "privcloud-companion-extension-ready";
const probes = new WeakMap<
  Window,
  { expiresAt: number; promise: Promise<ExtensionResponse | null> }
>();

export type CompanionExtensionState = {
  installed: boolean;
  version?: string;
  health?: BridgeHealth;
};
type ExtensionResponse = {
  ok: boolean;
  result?: unknown;
  error?: string | { message?: string; statusCode?: number };
};

function requestFromExtensionRaw(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<ExtensionResponse | null> {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  )
    return Promise.resolve(null);
  const target = window;
  if (signal?.aborted)
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.clearTimeout(timer);
      target.removeEventListener(RESPONSE_EVENT, onResponse as EventListener);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const onResponse = (event: CustomEvent) => {
      if (event.detail?.id !== id) return;
      cleanup();
      resolve(event.detail.response ?? { ok: false });
    };
    const timer = target.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    target.addEventListener(RESPONSE_EVENT, onResponse as EventListener);
    signal?.addEventListener("abort", onAbort, { once: true });
    target.dispatchEvent(
      new CustomEvent(REQUEST_EVENT, { detail: { id, type, payload } }),
    );
  });
}

async function probeExtension(): Promise<ExtensionResponse | null> {
  if (typeof window === "undefined") return null;
  const previous = probes.get(window);
  if (previous && previous.expiresAt > Date.now()) return previous.promise;
  const promise = requestFromExtensionRaw("privcloud.companion.probe", {}, 400);
  probes.set(window, { promise, expiresAt: Date.now() + 2000 });
  return promise;
}

export async function requireCompanionExtension(): Promise<void> {
  if (typeof window === "undefined" || !window.isSecureContext)
    throw new Error("bridge.error.secureContextRequired");
  const probe = await probeExtension();
  if (!probe) throw new Error("bridge.error.extensionRequired");
  if (
    !probe.ok ||
    (probe.result as { nativeTransportVersion?: number })
      ?.nativeTransportVersion !== 1
  )
    throw new Error("bridge.error.updateRequired");
}

export async function requestCompanionCommand<T>(
  command: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  await requireCompanionExtension();
  const response = await requestFromExtensionRaw(
    `privcloud.companion.${command}`,
    payload,
    60_000,
    signal,
  );
  if (!response) throw new Error("bridge.error.timeout");
  if (!response.ok) {
    const raw =
      typeof response.error === "string"
        ? response.error
        : response.error?.message;
    const message =
      raw && /^(bridge|webdav|upload)\.error\.[A-Za-z]+$/.test(raw)
        ? raw
        : "bridge.error.unavailable";
    throw new Error(message);
  }
  return response.result as T;
}

export function onCompanionExtensionReady(
  callback: (_version?: string) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: CustomEvent) => {
    probes.delete(window);
    callback(event.detail?.version);
  };
  window.addEventListener(EXTENSION_READY_EVENT, handler as EventListener);
  return () =>
    window.removeEventListener(EXTENSION_READY_EVENT, handler as EventListener);
}

export async function getCompanionExtensionState(): Promise<CompanionExtensionState> {
  const response = await probeExtension();
  if (!response) return { installed: false };
  const version = (response.result as { version?: string })?.version;
  const health = await requestCompanionCommand<BridgeHealth>("health").catch(
    () => undefined,
  );
  return { installed: true, version, health };
}

export async function openPrivCloudFromExtension(path = "/upload") {
  const response = await requestFromExtensionRaw(
    "privcloud.open",
    { path },
    2500,
  );
  return response?.ok ? response.result : null;
}
