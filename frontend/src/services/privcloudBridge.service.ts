import {
  usesAndroidLoopback,
  androidBridgeFetch,
  readAndroidBridgeJson,
} from "./bridgeAndroidLoopback.service";
import {
  requireCompanionExtension,
  requestCompanionCommand,
} from "./privcloudCompanion.service";
import type { WebDavCredentials, WebDavEntry } from "./webdav.service";

const TOKEN_STORAGE_KEY = "privcloud_native_session_v1";

export type BridgeHealth = {
  name: string;
  version: string;
  bridgeId: string;
  paired: boolean;
  capabilities: {
    webdav: boolean;
    directBrowserImport: boolean;
    managedEncryptedUpload: boolean;
    fileMetadataV1?: boolean;
    relativePathsV1?: boolean;
    directS3Upload?: boolean;
    localTokenAuthorization?: boolean;
    openSourceLocalAuthorization?: boolean;
    nativeMessaging?: boolean;
    browserExtension?: boolean;
    mailAssistants?: boolean;
  };
  nativeHost?: string;
  nativeTransportVersion?: number;
  jobs?: {
    active: number;
    total: number;
    maxActive: number;
    maxFilesPerJob: number;
    staleAfterMs: number;
  };
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
  fileMetadataScheme?: number | null;
  webdav: WebDavCredentials;
  files: Array<
    Pick<
      WebDavEntry,
      "href" | "name" | "size" | "contentType" | "lastModified"
    > & { relativePath?: string }
  >;
};

export class BridgeUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("bridge.error.unavailable", { cause });
    this.name = "BridgeUnavailableError";
  }
}

type NativeSession = { token: string; expiresAt: number };
let authorization: Promise<void> | null = null;

function getSession(): NativeSession | null {
  if (typeof window === "undefined") return null;
  try {
    const session = JSON.parse(
      window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "null",
    );
    return typeof session?.token === "string" &&
      Number.isFinite(session.expiresAt)
      ? session
      : null;
  } catch {
    return null;
  }
}

function clearToken() {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      /* Storage may be disabled. */
    }
  }
}

export async function getBridgeHealth(
  options: { requestLocalAccess?: boolean } = {},
): Promise<BridgeHealth | null> {
  if (!options.requestLocalAccess && !hasBridgeToken()) return null;
  try {
    if (usesAndroidLoopback())
      return readAndroidBridgeJson<BridgeHealth>(
        await androidBridgeFetch("/health", {
          requestAccess: options.requestLocalAccess,
        }),
      );
    const health = await requestCompanionCommand<BridgeHealth>("health");
    if (health.nativeTransportVersion !== 1)
      throw new Error("bridge.error.updateRequired");
    return health;
  } catch (error) {
    if (options.requestLocalAccess) throw error;
    return null;
  }
}

export async function authorizeBridge(): Promise<void> {
  if (authorization) return authorization;
  authorization = (async () => {
    if (!usesAndroidLoopback()) await requireCompanionExtension();
    const previous = getSession();
    const payload = { sessionToken: previous?.token };
    let session: NativeSession;
    if (usesAndroidLoopback()) {
      const data = await readAndroidBridgeJson<{ token: string }>(
        await androidBridgeFetch("/tokens", {
          body: { ...payload, label: window.location.origin },
        }),
      );
      session = { token: data.token, expiresAt: Date.now() + 14 * 60_000 };
    } else {
      session = await requestCompanionCommand<NativeSession>(
        "authorize",
        payload,
      );
    }
    if (
      !session?.token ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= Date.now()
    )
      throw new Error("bridge.error.unavailable");
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(session));
  })();
  try {
    await authorization;
  } finally {
    authorization = null;
  }
}

async function nativeCommand<T>(
  command: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let session = getSession();
  if (!session) throw new Error("bridge.error.sessionExpired");
  if (session.expiresAt <= Date.now() + 30_000) {
    await authorizeBridge();
    session = getSession();
  }
  try {
    if (usesAndroidLoopback()) {
      const routes: Record<string, string> = {
        "webdav.list": "/webdav/list",
        "webdav.upload.start": "/jobs/webdav-upload",
        "jobs.get": `/jobs/${encodeURIComponent(String(payload.jobId || ""))}`,
        "jobs.cancel": `/jobs/${encodeURIComponent(String(payload.jobId || ""))}/cancel`,
      };
      const path = routes[command];
      if (!path) throw new Error("bridge.error.badRequest");
      const response = await androidBridgeFetch(path, {
        token: session?.token,
        body: command === "jobs.get" ? undefined : payload,
        signal,
      });
      if (response.status === 401) clearToken();
      return readAndroidBridgeJson<T>(response);
    }
    return await requestCompanionCommand<T>(
      command,
      { ...payload, sessionToken: session?.token },
      signal,
    );
  } catch (error) {
    // Never replay a mutation: a lost response can still mean an upload started.
    if (
      error instanceof Error &&
      error.message === "bridge.error.sessionExpired"
    )
      clearToken();
    throw error;
  }
}

export async function listWebDavDirectoryViaBridge(
  credentials: WebDavCredentials,
  href?: string,
  signal?: AbortSignal,
): Promise<BridgeListResult> {
  return nativeCommand("webdav.list", { ...credentials, href }, signal);
}

export async function downloadWebDavFileViaBridge(
  credentials: WebDavCredentials,
  entry: WebDavEntry,
  signal?: AbortSignal,
): Promise<File> {
  if (usesAndroidLoopback()) {
    const session = getSession();
    if (!session) throw new Error("bridge.error.sessionExpired");
    if (session.expiresAt <= Date.now() + 30_000) await authorizeBridge();
    const response = await androidBridgeFetch("/webdav/download", {
      body: { ...credentials, href: entry.href },
      token: getSession()?.token,
      signal,
    });
    if (response.status === 401) clearToken();
    if (!response.ok) await readAndroidBridgeJson(response);
    const blob = await response.blob();
    return new File([blob], entry.name, {
      type: entry.contentType || blob.type,
      lastModified: entry.lastModified
        ? Date.parse(entry.lastModified)
        : Date.now(),
    });
  }
  const opened = await nativeCommand<{
    downloadId: string;
    contentType: string;
  }>("webdav.download.open", { ...credentials, href: entry.href }, signal);
  const parts: ArrayBuffer[] = [];
  let complete = false;
  try {
    while (!complete) {
      const chunk = await nativeCommand<{ data: string; done: boolean }>(
        "webdav.download.read",
        { downloadId: opened.downloadId },
        signal,
      );
      if (
        typeof chunk.data !== "string" ||
        chunk.data.length > 256 * 1024 ||
        typeof chunk.done !== "boolean"
      )
        throw new Error("bridge.error.badRequest");
      const bytes = Uint8Array.from(atob(chunk.data), (character) =>
        character.charCodeAt(0),
      );
      parts.push(bytes.buffer);
      complete = chunk.done;
    }
    return new File(parts, entry.name, {
      type: entry.contentType || opened.contentType,
      lastModified: entry.lastModified
        ? Date.parse(entry.lastModified)
        : Date.now(),
    });
  } finally {
    if (!complete)
      await nativeCommand("webdav.download.close", {
        downloadId: opened.downloadId,
      }).catch(() => undefined);
  }
}

export async function startBridgeWebDavUploadJob(
  payload: StartBridgeWebDavUploadJobPayload,
): Promise<BridgeUploadJob> {
  const hasPaths = payload.files.some((file) => !!file.relativePath);
  if (payload.fileMetadataScheme === 1 || hasPaths) {
    const health = await getBridgeHealth();
    if (hasPaths && !health?.capabilities.relativePathsV1)
      throw new Error("webdav.error.companionFolderUpdateRequired");
    if (
      payload.fileMetadataScheme === 1 &&
      !health?.capabilities.fileMetadataV1
    )
      throw new Error("bridge.error.updateRequired");
  }
  return nativeCommand("webdav.upload.start", { ...payload });
}

export async function getBridgeUploadJob(
  jobId: string,
): Promise<BridgeUploadJob> {
  return nativeCommand("jobs.get", { jobId });
}

export async function cancelBridgeUploadJob(
  jobId: string,
): Promise<BridgeUploadJob> {
  return nativeCommand("jobs.cancel", { jobId });
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = Object.assign(new Error("Bridge upload cancelled"), {
        cancelled: true,
      });
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
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

    try {
      await wait(options.pollIntervalMs ?? 1000, options.signal);
    } catch (error) {
      if (options.signal?.aborted)
        await cancelBridgeUploadJob(jobId).catch(() => undefined);
      throw error;
    }
  }
}

export function hasBridgeToken(): boolean {
  return !!getSession();
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
