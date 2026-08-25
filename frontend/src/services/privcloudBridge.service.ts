import type { WebDavCredentials, WebDavEntry } from "./webdav.service";

const BRIDGE_BASE_URLS = [
  "http://127.0.0.1:47631/v1",
  "http://localhost:47631/v1",
];
const TOKEN_STORAGE_KEY = "privcloud_bridge_token";
const BASE_URL_STORAGE_KEY = "privcloud_bridge_base_url";

export type BridgeHealth = {
  name: string;
  version: string;
  bridgeId: string;
  paired: boolean;
  capabilities: {
    webdav: boolean;
    directBrowserImport: boolean;
    managedEncryptedUpload: boolean;
    localTokenAuthorization?: boolean;
    openSourceLocalAuthorization?: boolean;
    nativeMessaging?: boolean;
    browserExtension?: boolean;
    mailAssistants?: boolean;
  };
  nativeHost?: string;
  jobs?: {
    active: number;
    total: number;
    maxActive: number;
    maxFilesPerJob: number;
    staleAfterMs: number;
  };
};

export type BridgePairing = {
  pairingId: string;
  expiresAt: string;
};

export type BridgeListResult = {
  url: string;
  entries: WebDavEntry[];
};

export type BridgeUploadJob = {
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  totalBytes: number;
  uploadedBytes: number;
  totalFiles: number;
  completedFiles: number;
  currentFileName?: string | null;
  error?: string | null;
  files: Array<{
    name: string;
    size: number;
    state: "queued" | "running" | "completed" | "failed" | "cancelled";
    uploadedBytes: number;
    error?: string | null;
  }>;
};

export type StartBridgeWebDavUploadJobPayload = {
  appBaseUrl: string;
  shareId: string;
  uploadToken: string;
  chunkSize: number;
  isE2EEncrypted: boolean;
  encryptionKey?: string | null;
  webdav: WebDavCredentials;
  files: Array<
    Pick<WebDavEntry, "href" | "name" | "size" | "contentType" | "lastModified">
  >;
};

export class BridgeUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("bridge.error.unavailable", { cause });
    this.name = "BridgeUnavailableError";
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

function setToken(token: string) {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearToken() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function bridgeFetch(
  path: string,
  init: RequestInit = {},
  options: { auth?: boolean } = {},
) {
  const token = getToken();
  const storedBaseUrl =
    typeof window !== "undefined"
      ? window.localStorage.getItem(BASE_URL_STORAGE_KEY)
      : null;
  // Never send the local bearer token to a URL read directly from storage.
  // Only the two hard-coded loopback endpoints are valid Bridge targets.
  const preferred = BRIDGE_BASE_URLS.includes(storedBaseUrl || "")
    ? storedBaseUrl
    : null;
  const bases = [
    ...(preferred ? [preferred] : []),
    ...BRIDGE_BASE_URLS.filter((url) => url !== preferred),
  ];

  let response: Response | null = null;
  for (const baseUrl of bases) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 6000);
      const sig = init.signal ?? controller.signal;
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...(options.auth !== false && token
            ? { Authorization: `Bearer ${token}` }
            : {}),
          ...init.headers,
        },
        signal: sig,
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem(BASE_URL_STORAGE_KEY, baseUrl);
      }
      break;
    } catch (e) {
      if (init.signal?.aborted) throw e;
      if (baseUrl === bases[bases.length - 1]) {
        throw new BridgeUnavailableError(e);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  if (!response) throw new BridgeUnavailableError();

  if (response.status === 401) {
    clearToken();
  }

  return response;
}

async function readBridgeJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || `Bridge HTTP ${response.status}`);
  }
  return data as T;
}

export async function getBridgeHealth(): Promise<BridgeHealth | null> {
  try {
    const response = await bridgeFetch("/health", {}, { auth: false });
    if (!response.ok) return null;
    return readBridgeJson<BridgeHealth>(response);
  } catch {
    // On mobile (Android/iOS), the PNA preflight may take longer on first
    // contact. Retry once after a short delay before giving up.
    if (
      typeof navigator !== "undefined" &&
      /Android|iPhone|iPad/i.test(navigator.userAgent)
    ) {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        const retry = await bridgeFetch("/health", {}, { auth: false });
        if (!retry.ok) return null;
        return readBridgeJson<BridgeHealth>(retry);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function startBridgePairing(): Promise<BridgePairing> {
  const response = await bridgeFetch("/pairings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readBridgeJson<BridgePairing>(response);
}

export async function confirmBridgePairing(
  pairingId: string,
  code: string,
): Promise<void> {
  const response = await bridgeFetch(
    `/pairings/${encodeURIComponent(pairingId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, label: window.location.origin }),
    },
  );
  const data = await readBridgeJson<{ token: string }>(response);
  setToken(data.token);
}

export async function authorizeBridge(): Promise<void> {
  const response = await bridgeFetch(
    "/tokens",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: window.location.origin }),
    },
    { auth: false },
  );
  if (response.status === 404) {
    throw new Error("bridge.error.updateRequired");
  }
  const data = await readBridgeJson<{ token: string }>(response);
  setToken(data.token);
}

export async function listWebDavDirectoryViaBridge(
  credentials: WebDavCredentials,
  href?: string,
): Promise<BridgeListResult> {
  const response = await bridgeFetch("/webdav/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, href }),
  });
  return readBridgeJson<BridgeListResult>(response);
}

export async function downloadWebDavFileViaBridge(
  credentials: WebDavCredentials,
  entry: WebDavEntry,
  signal?: AbortSignal,
): Promise<File> {
  const response = await bridgeFetch("/webdav/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, href: entry.href }),
    signal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.message || `Bridge HTTP ${response.status}`);
  }

  const blob = await response.blob();
  return new File([blob], entry.name, {
    type: entry.contentType || blob.type || "application/octet-stream",
    lastModified: entry.lastModified
      ? Date.parse(entry.lastModified)
      : Date.now(),
  });
}

export async function startBridgeWebDavUploadJob(
  payload: StartBridgeWebDavUploadJobPayload,
): Promise<BridgeUploadJob> {
  const response = await bridgeFetch("/jobs/webdav-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readBridgeJson<BridgeUploadJob>(response);
}

export async function getBridgeUploadJob(
  jobId: string,
): Promise<BridgeUploadJob> {
  const response = await bridgeFetch(`/jobs/${encodeURIComponent(jobId)}`);
  return readBridgeJson<BridgeUploadJob>(response);
}

export async function cancelBridgeUploadJob(
  jobId: string,
): Promise<BridgeUploadJob> {
  const response = await bridgeFetch(
    `/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  return readBridgeJson<BridgeUploadJob>(response);
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          const error = new Error("Bridge upload cancelled");
          (error as any).cancelled = true;
          reject(error);
        },
        { once: true },
      );
    }
  });
}

export async function waitForBridgeUploadJob(
  jobId: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (_job: BridgeUploadJob) => void;
    pollIntervalMs?: number;
  } = {},
): Promise<BridgeUploadJob> {
  for (;;) {
    if (options.signal?.aborted) {
      await cancelBridgeUploadJob(jobId).catch(() => undefined);
      const error = new Error("Bridge upload cancelled");
      (error as any).cancelled = true;
      throw error;
    }

    const job = await getBridgeUploadJob(jobId);
    options.onProgress?.(job);

    if (job.state === "completed") return job;
    if (job.state === "failed" || job.state === "cancelled") {
      const error = new Error(job.error || `Bridge job ${job.state}`);
      (error as any).cancelled = job.state === "cancelled";
      throw error;
    }

    await wait(options.pollIntervalMs ?? 1000, options.signal);
  }
}

export function hasBridgeToken(): boolean {
  return !!getToken();
}

/** Reject older Companion builds that do not implement the OSS contract. */
export function isOpenSourceBridgeCompatible(
  health: BridgeHealth | null,
): boolean {
  return !!(
    health?.capabilities.webdav &&
    health.capabilities.localTokenAuthorization === true &&
    health.capabilities.openSourceLocalAuthorization === true
  );
}

export function forgetBridgeToken() {
  clearToken();
}
