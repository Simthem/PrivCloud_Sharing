import { deleteCookie, setCookie } from "cookies-next";
import { Zip, ZipPassThrough } from "fflate";
import mime from "mime-types";
import { FileMetaData, FileUploadResponse } from "../types/File.type";
import {
  decryptStream,
  downloadDecryptedBlob,
  importKeyFromBase64,
} from "../utils/crypto.util";
import { completeSafeLineChallenge, refreshTokenOnce } from "./api.service";
import { notifySafeLineChallenge } from "../utils/safeline-notify.util";
import { translateOutsideContext } from "../hooks/useTranslate.hook";
import { getSafeZipEntryName } from "../utils/uploadPath.util";
import {
  doesFileSupportPreview,
  resolveFileMimeType,
} from "../utils/filePreview.util";
import {
  createDownloadProgressReporter,
  MAX_IN_MEMORY_DOWNLOAD_SIZE,
  writeDownloadChunksToDisk,
} from "../utils/downloadStream.util";
import { createResumableDownloadBody as createResumableResponseBody } from "../utils/downloadResume.util";
import {
  createParallelDirectDownloadBody,
  createRefreshingDirectRangeFetcher,
  DEFAULT_DIRECT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DIRECT_DOWNLOAD_MAX_BUFFER_BYTES,
  DEFAULT_DIRECT_DOWNLOAD_PART_BYTES,
  resolveDirectDownloadParallelConfig,
} from "../utils/downloadParallel.util";
import { apiPathSegment } from "../utils/apiPath.util";

import {
  AdminShare,
  CreateReverseShare,
  CreateShare,
  MyReverseShare,
  MyShare,
  ReverseShare,
  Share,
  ShareMetaData,
} from "../types/share.type";
import api from "./api.service";

const list = async (): Promise<AdminShare[]> => {
  return (await api.get(`shares/all`)).data;
};

const removeFromAdminInventory = async (reference: string) => {
  await api.delete(`shares/admin/${apiPathSegment(reference)}`);
};

const create = async (share: CreateShare, isReverseShare = false) => {
  if (!isReverseShare) {
    deleteCookie("reverse_share_token");
  }
  return (await api.post("shares", share)).data;
};

const completeShare = async (id: string, e2eKey?: string) => {
  const response = (
    await api.post(
      `shares/${apiPathSegment(id)}/complete`,
      e2eKey ? { e2eKey } : {},
    )
  ).data;
  deleteCookie("reverse_share_token");
  return response;
};

const keepUploadAlive = async (id: string) => {
  await api.post(`shares/${apiPathSegment(id)}/upload-heartbeat`);
};

const createBridgeUploadToken = async (
  id: string,
  label?: string,
): Promise<{ token: string; expiresAt: string }> => {
  return (
    await api.post(`shares/${apiPathSegment(id)}/bridge-upload-token`, {
      label,
    })
  ).data;
};

const revertComplete = async (id: string) => {
  return (await api.delete(`shares/${apiPathSegment(id)}/complete`)).data;
};

const get = async (id: string): Promise<Share> => {
  return (await api.get(`shares/${apiPathSegment(id)}`)).data;
};

const getFromOwner = async (id: string): Promise<Share> => {
  return (await api.get(`shares/${apiPathSegment(id)}/from-owner`)).data;
};

const getMetaData = async (id: string): Promise<ShareMetaData> => {
  return (await api.get(`shares/${apiPathSegment(id)}/metaData`)).data;
};

const remove = async (id: string) => {
  await api.delete(`shares/${apiPathSegment(id)}`);
};

const getMyShares = async (): Promise<MyShare[]> => {
  return (await api.get("shares")).data;
};

const getStoredRecipients = async (): Promise<Array<string>> => {
  return (await api.get("shares/recipients")).data;
};

const getShareToken = async (
  id: string,
  password?: string,
  captchaToken?: string,
) => {
  await api.post(`/shares/${apiPathSegment(id)}/token`, {
    password,
    ...(captchaToken && { captchaToken }),
  });
};

const isShareIdAvailable = async (id: string): Promise<boolean> => {
  return (await api.get(`/shares/isShareIdAvailable/${apiPathSegment(id)}`))
    .data.isAvailable;
};

const downloadFile = async (shareId: string, fileId: string) => {
  const relayUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}`;
  try {
    const authorization = (
      await api.get(
        `/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}/direct`,
      )
    ).data as { direct?: boolean; url?: string };
    const downloadUrl =
      authorization.direct && authorization.url ? authorization.url : relayUrl;
    window.location.assign(
      new URL(downloadUrl, window.location.origin).toString(),
    );
  } catch {
    window.location.assign(
      new URL(relayUrl, window.location.origin).toString(),
    );
  }
};

// Cache du chunkSize pour éviter des appels API répétés
let _cachedChunkSize: number | null = null;
const getChunkSize = async (): Promise<number> => {
  if (_cachedChunkSize !== null) return _cachedChunkSize;
  const configs = (await api.get("/configs")).data;
  const cfg = configs.find(
    (c: { key: string; value?: string; defaultValue?: string }) =>
      c.key === "share.chunkSize",
  );
  _cachedChunkSize = cfg
    ? parseInt(cfg.value ?? cfg.defaultValue ?? "10000000")
    : 10000000;
  return _cachedChunkSize;
};

const getEncryptionRecordConfig = (
  response: Response,
  legacyFallback: number,
): { size: number; exact: boolean } => {
  const advertised = Number(response.headers.get("X-Encryption-Chunk-Size"));
  const exact =
    Number.isSafeInteger(advertised) &&
    advertised >= 1_000_000 &&
    advertised <= 200_000_000;
  return { size: exact ? advertised : legacyFallback, exact };
};

/**
 * Native fetch wrapper with SafeLine 468 challenge retry loop.
 * Axios interceptors don't apply to native fetch, so we handle 468 here.
 *
 * Uses mode: "same-origin" so the browser sends Sec-Fetch-Mode: same-origin
 * instead of "cors" (the fetch() default).  SafeLine WAF treats same-origin
 * requests more permissively for large binary responses (file downloads).
 *
 * On 468:
 *  1. Try hidden iframe auto-solve (completeSafeLineChallenge).
 *  2. If that fails, fire cross-tab notification (OS popup + audio beep) so
 *     the user can manually solve the challenge.
 *  3. Retry with exponential backoff up to MAX_468_RETRIES.
 */
const MAX_468_RETRIES = 5;
const DOWNLOAD_468_BACKOFF_BASE = 5_000; // 5 s

const fetchSameOriginStreaming = async (
  url: string,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<Response> => {
  const opts: RequestInit = {
    credentials: "include",
    mode: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/octet-stream",
      "X-Download-Stream": "1",
      ...extraHeaders,
    },
    ...(signal && { signal }),
  };

  let _lastResponse: Response | null = null;
  let tokenRefreshAttempted = false;
  let transientAttempts = 0;

  for (let attempt = 0; attempt <= MAX_468_RETRIES; attempt++) {
    const response = await fetch(url, opts);
    const responseType = response.headers.get("Content-Type") || "";
    const wafLike403 =
      response.status === 403 &&
      !responseType.toLowerCase().includes("application/json");

    if (response.status === 401 && !tokenRefreshAttempted) {
      tokenRefreshAttempted = true;
      await response.body?.cancel().catch(() => undefined);
      const refreshed = await refreshTokenOnce();
      if (refreshed.ok) {
        attempt--;
        continue;
      }
    }

    if (
      [429, 502, 503, 504].includes(response.status) &&
      transientAttempts < 5
    ) {
      transientAttempts++;
      await response.body?.cancel().catch(() => undefined);
      const retryAfterSeconds = Number(response.headers.get("Retry-After"));
      const delay =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1_000, 30_000)
          : Math.min(500 * Math.pow(2, transientAttempts - 1), 8_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt--;
      continue;
    }

    if (response.status !== 468 && !wafLike403) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    }

    // SafeLine uses 468 for its explicit challenge and can emit an HTML 403
    // when a session cookie expires. A JSON 403 remains an application access
    // decision and is never treated as a WAF challenge.
    _lastResponse = response;
    await response.body?.cancel().catch(() => undefined);

    // Try auto-solve via hidden iframe
    try {
      await completeSafeLineChallenge();
      // Solved -- retry immediately
      continue;
    } catch {
      // Iframe failed -- notify user
    }

    // Cross-tab alert: OS notification + audio beep + title flash
    notifySafeLineChallenge();

    // Backoff before next attempt (5s, 10s, 20s, 40s, 80s)
    const delay = DOWNLOAD_468_BACKOFF_BASE * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
  }

  const t = translateOutsideContext();
  throw new Error(t("safeline.download.failed", { retries: MAX_468_RETRIES }));
};

type DirectDownloadAuthorization = {
  direct: true;
  url: string;
  candidates?: Array<{
    url: string;
    origin: string;
    addressingMode: "path" | "virtual-host";
  }>;
  expiresInSeconds: number;
  size: number;
  encryptionChunkSize: number | null;
  contentType?: string;
  directDownloadConcurrency?: number;
  directDownloadPartBytes?: number;
  directDownloadThresholdBytes?: number;
  directDownloadMaxBufferBytes?: number;
};

type DirectDownloadSession = DirectDownloadAuthorization & {
  expiresAt: number;
};

const directDownloadSessions = new Map<string, DirectDownloadSession>();
const MAX_CACHED_DIRECT_DOWNLOAD_SESSIONS = 128;

const cacheDirectDownloadSession = (
  downloadUrl: string,
  authorization: DirectDownloadSession,
) => {
  const now = Date.now();
  for (const [cachedUrl, cached] of directDownloadSessions) {
    if (cached.expiresAt <= now) directDownloadSessions.delete(cachedUrl);
  }
  while (
    !directDownloadSessions.has(downloadUrl) &&
    directDownloadSessions.size >= MAX_CACHED_DIRECT_DOWNLOAD_SESSIONS
  ) {
    const oldest = directDownloadSessions.keys().next().value;
    if (typeof oldest !== "string") break;
    directDownloadSessions.delete(oldest);
  }
  directDownloadSessions.delete(downloadUrl);
  directDownloadSessions.set(downloadUrl, authorization);
};

const getDirectDownloadAuthorizationUrl = (
  downloadUrl: string,
): string | null => {
  if (typeof window === "undefined") return null;
  const parsed = new URL(downloadUrl, window.location.origin);
  if (
    parsed.origin !== window.location.origin ||
    !/^\/api\/shares\/[^/]+\/files\/[^/]+$/.test(parsed.pathname)
  ) {
    return null;
  }
  parsed.pathname += "/direct";
  return parsed.pathname + parsed.search;
};

const requestDirectDownloadAuthorization = async (
  downloadUrl: string,
  authorizationUrl: string,
  signal?: AbortSignal,
): Promise<DirectDownloadSession | null> => {
  const controlResponse = await fetchSameOriginStreaming(
    authorizationUrl,
    signal,
    { Accept: "application/json" },
  );
  const data = (await controlResponse.json()) as
    | DirectDownloadAuthorization
    | { direct?: false };
  if (
    !data.direct ||
    typeof data.url !== "string" ||
    !Number.isSafeInteger(data.size) ||
    data.size < 0
  ) {
    return null;
  }

  const authorization: DirectDownloadSession = {
    ...data,
    expiresAt:
      Date.now() + Math.max(60, Number(data.expiresInSeconds) || 60) * 1_000,
  };
  cacheDirectDownloadSession(downloadUrl, authorization);
  return authorization;
};

const getBoundedDirectDownloadThreshold = (
  advertised: number | undefined,
  partBytes: number,
): number => {
  const minimum = partBytes * 2;
  const fallback = Math.max(64 * 1024 * 1024, minimum);
  if (!Number.isSafeInteger(advertised) || advertised! < 0) return fallback;
  return Math.max(minimum, Math.min(advertised!, 4 * 1024 * 1024 * 1024));
};

const canUseParallelDirectDownload = (
  downloadUrl: string,
  authorization: DirectDownloadSession,
  isResume: boolean,
) => {
  if (isResume || authorization.size <= 0) return null;
  const parsed = new URL(downloadUrl, window.location.origin);
  // Prefix/preview reads intentionally stay mono-range: launching several
  // large ranges would waste bandwidth when the caller only consumes a prefix.
  if (parsed.searchParams.get("download") === "false") return null;

  const encryptedRecordBytes =
    authorization.encryptionChunkSize &&
    Number.isSafeInteger(authorization.encryptionChunkSize) &&
    authorization.encryptionChunkSize > 0
      ? authorization.encryptionChunkSize + 28
      : null;
  const config = resolveDirectDownloadParallelConfig({
    totalSize: authorization.size,
    concurrency:
      authorization.directDownloadConcurrency ??
      DEFAULT_DIRECT_DOWNLOAD_CONCURRENCY,
    partBytes:
      authorization.directDownloadPartBytes ??
      DEFAULT_DIRECT_DOWNLOAD_PART_BYTES,
    maxBufferBytes:
      authorization.directDownloadMaxBufferBytes ??
      DEFAULT_DIRECT_DOWNLOAD_MAX_BUFFER_BYTES,
    encryptedRecordBytes,
  });
  const threshold = getBoundedDirectDownloadThreshold(
    authorization.directDownloadThresholdBytes,
    config.partBytes,
  );
  return config.enabled && authorization.size >= threshold
    ? { config, encryptedRecordBytes }
    : null;
};

const fetchDirectStreaming = async (
  url: string,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> => {
  const authorizationUrl = getDirectDownloadAuthorizationUrl(url);
  if (!authorizationUrl) return null;
  const isResume = typeof extraHeaders.Range === "string";

  for (let attempt = 0; attempt < 2; attempt++) {
    let authorization: DirectDownloadSession | null | undefined =
      directDownloadSessions.get(url);
    if (
      !isResume ||
      !authorization ||
      authorization.expiresAt <= Date.now() + 30_000
    ) {
      try {
        authorization = await requestDirectDownloadAuthorization(
          url,
          authorizationUrl,
          signal,
        );
        if (!authorization) return null;
      } catch {
        return null;
      }
    }

    try {
      const parallel = canUseParallelDirectDownload(
        url,
        authorization,
        isResume,
      );
      if (parallel) {
        const fetchRange = createRefreshingDirectRangeFetcher({
          initialAuthorization: authorization,
          refreshAuthorization: async (stale, refreshSignal) => {
            const cached = directDownloadSessions.get(url);
            if (
              cached &&
              cached.url !== stale.url &&
              cached.expiresAt > Date.now() + 30_000
            ) {
              return cached;
            }
            directDownloadSessions.delete(url);
            const refreshed = await requestDirectDownloadAuthorization(
              url,
              authorizationUrl,
              refreshSignal,
            );
            if (!refreshed) {
              throw new Error("Direct download authorization refresh failed");
            }
            return refreshed;
          },
        });
        const direct = createParallelDirectDownloadBody({
          totalSize: authorization.size,
          concurrency: parallel.config.concurrency,
          partBytes: parallel.config.partBytes,
          maxBufferBytes: parallel.config.maxBufferBytes,
          encryptedRecordBytes: parallel.encryptedRecordBytes,
          fetchRange,
          signal,
        });
        const headers = new Headers({
          "Accept-Ranges": "bytes",
          "Content-Length": String(authorization.size),
          "Content-Type":
            authorization.contentType || "application/octet-stream",
        });
        if (authorization.encryptionChunkSize) {
          headers.set(
            "X-Encryption-Chunk-Size",
            String(authorization.encryptionChunkSize),
          );
        }
        console.info(
          `[download] init -> transport=direct-s3-ranges lanes=${direct.config.concurrency} ` +
            `partMiB=${Math.round(direct.config.partBytes / 1024 / 1024)} ` +
            `bufferMiB=${Math.round(direct.config.maxBufferBytes / 1024 / 1024)} ` +
            `parts=${direct.config.totalParts} isE2E=${Boolean(authorization.encryptionChunkSize)}`,
        );
        return new Response(direct.stream, {
          status: 200,
          headers,
        });
      }

      const directHeaders: Record<string, string> = {
        Accept: "application/octet-stream",
      };
      if (extraHeaders.Range) directHeaders.Range = extraHeaders.Range;
      const response = await fetch(authorization.url, {
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        headers: directHeaders,
        ...(signal && { signal }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 403 && attempt === 0) {
          directDownloadSessions.delete(url);
          continue;
        }
        return null;
      }
      if (isResume && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }

      // Preserve the metadata headers previously emitted by Nest. S3 owns
      // Content-Length/Content-Range; the encrypted-record layout remains
      // trusted metadata returned by the authenticated control plane.
      const headers = new Headers(response.headers);
      if (
        authorization.encryptionChunkSize &&
        !headers.has("X-Encryption-Chunk-Size")
      ) {
        headers.set(
          "X-Encryption-Chunk-Size",
          String(authorization.encryptionChunkSize),
        );
      }
      if (!isResume && !headers.has("Content-Length")) {
        headers.set("Content-Length", String(authorization.size));
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      directDownloadSessions.delete(url);
      return null;
    }
  }
  return null;
};

const fetchStreaming = async (
  url: string,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<Response> => {
  const directResponse = await fetchDirectStreaming(url, signal, extraHeaders);
  if (directResponse) return directResponse;
  return fetchSameOriginStreaming(url, signal, extraHeaders);
};

/**
 * Keep one logical byte stream alive across a dropped HTTP response.
 *
 * The next request starts at the exact number of bytes already enqueued into
 * the stream. This also works for E2E data: decryptStream keeps any partial
 * AES-GCM record in its own buffer while this source reconnects underneath it.
 */
const createResumableDownloadBody = (
  url: string,
  initialResponse: Response,
  signal?: AbortSignal,
): { stream: ReadableStream<Uint8Array>; totalSize: number } =>
  createResumableResponseBody(
    initialResponse,
    (offset) =>
      fetchStreaming(url, signal, {
        Range: `bytes=${offset}-`,
        "X-Download-Resume": "1",
      }),
    signal,
  );

/**
 * Télécharge un fichier chiffré E2E en streaming, le déchiffre chunk par
 * chunk côté client, puis écrit sur disque progressivement.
 *
 * - Chrome/Edge : File System Access API (showSaveFilePicker) -> écriture
 *   directe sur disque, mémoire bornée aux records crypto + 32 MiB.
 * - Firefox/Safari : accumulation des chunks déchiffrés en Blob parts
 *   uniquement pour les fichiers assez petits pour rester sûrs en mémoire.
 */
const downloadFileE2E = async (
  shareId: string,
  fileId: string,
  fileName: string,
  encodedKey: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const downloadUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}`;
  const keyPromise = importKeyFromBase64(encodedKey);
  const chunkSizePromise = getChunkSize();
  const mimeType = (
    mime.contentType(fileName) || "application/octet-stream"
  ).split(";")[0];

  // Start crypto preparation, config lookup and network request together.
  // The save picker then hides most of this startup latency.
  const fetchPromise = fetchStreaming(downloadUrl, signal);

  // Try File System Access API -- must be called in user gesture context
  // (before any async network operation that would expire the gesture).
  let writable: FileSystemWritableFileStream | null = null;
  let fileHandle: FileSystemFileHandle | null = null;
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: fileName,
      });
      writable = await fileHandle!.createWritable();
    } catch (e: any) {
      if (e.name === "AbortError") {
        try {
          (await fetchPromise).body?.cancel();
        } catch {
          /* ignored */
        }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const [response, key, legacyChunkSize] = await Promise.all([
    fetchPromise,
    keyPromise,
    chunkSizePromise,
  ]);
  const resumable = createResumableDownloadBody(downloadUrl, response, signal);
  const totalSize = resumable.totalSize;
  const cryptoRecord = getEncryptionRecordConfig(response, legacyChunkSize);

  if (!writable && totalSize > MAX_IN_MEMORY_DOWNLOAD_SIZE) {
    await resumable.stream.cancel();
    const error = new Error("Direct disk access is required for this download");
    error.name = "LargeDownloadRequiresDiskAccessError";
    throw error;
  }

  const progress = createDownloadProgressReporter(onProgress, totalSize);

  // Wrap stream with progress tracking when callback is provided.
  // TransformStream counts encrypted bytes as they flow to decryptStream.
  let body: ReadableStream<Uint8Array> = resumable.stream;
  if (onProgress) {
    let bytesRead = 0;
    body = resumable.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesRead += chunk.length;
          progress.update(bytesRead);
          controller.enqueue(chunk);
        },
      }),
    );
  }

  if (writable) {
    // Batch the small crypto records into stable sequential disk writes.
    try {
      await writeDownloadChunksToDisk(
        decryptStream(
          body,
          key,
          cryptoRecord.size,
          totalSize,
          cryptoRecord.exact,
        ),
        writable,
        signal,
      );
      await writable.close();
      progress.complete(totalSize);
    } catch (e) {
      try {
        await writable.abort();
      } catch {
        /* ignored */
      }
      // Supprime le fichier 0-octet stub créé par le picker
      if (fileHandle && (fileHandle as any).remove) {
        try {
          await (fileHandle as any).remove();
        } catch {
          /* ignored */
        }
      }
      throw e;
    }
  } else {
    // Fallback: accumulate decrypted chunks into Blob parts.
    // Blob can be backed by disk internally, unlike ArrayBuffer.
    const parts: BlobPart[] = [];
    for await (const chunk of decryptStream(
      body,
      key,
      cryptoRecord.size,
      totalSize,
      cryptoRecord.exact,
    )) {
      parts.push(new Uint8Array(chunk) as BlobPart);
    }
    const blob = new Blob(parts, { type: mimeType });
    downloadDecryptedBlob(blob, fileName);
    progress.complete(totalSize);
  }
};

/**
 * Récupère un fichier chiffré E2E sous forme d'ArrayBuffer déchiffré.
 * Utilisé pour les previews.  Streaming decrypt réduit le peak mémoire
 * en ne gardant jamais le buffer chiffré + déchiffré simultanément.
 */
const fetchDecryptedFile = async (
  shareId: string,
  fileId: string,
  encodedKey: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> => {
  const downloadUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}?download=false`;
  const [key, legacyChunkSize, response] = await Promise.all([
    importKeyFromBase64(encodedKey),
    getChunkSize(),
    fetchStreaming(downloadUrl, signal),
  ]);
  const resumable = createResumableDownloadBody(downloadUrl, response, signal);
  const totalSize = resumable.totalSize;
  const cryptoRecord = getEncryptionRecordConfig(response, legacyChunkSize);

  const parts: Uint8Array[] = [];
  let totalDecrypted = 0;
  for await (const chunk of decryptStream(
    resumable.stream,
    key,
    cryptoRecord.size,
    totalSize,
    cryptoRecord.exact,
  )) {
    parts.push(chunk);
    totalDecrypted += chunk.length;
  }

  // Combine into a single ArrayBuffer for the caller
  const result = new Uint8Array(totalDecrypted);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result.buffer;
};

/**
 * Decrypt only the beginning of an E2E file for text/code previews. Breaking
 * the generator cancels the response body, so a multi-gigabyte JSON preview
 * costs at most one crypto record plus the requested prefix in memory.
 */
const fetchDecryptedFilePrefix = async (
  shareId: string,
  fileId: string,
  encodedKey: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid preview size limit");
  }

  const downloadUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}?download=false`;
  const [key, legacyChunkSize, response] = await Promise.all([
    importKeyFromBase64(encodedKey),
    getChunkSize(),
    fetchStreaming(downloadUrl, signal),
  ]);
  const resumable = createResumableDownloadBody(downloadUrl, response, signal);
  const totalSize = resumable.totalSize;
  const cryptoRecord = getEncryptionRecordConfig(response, legacyChunkSize);

  const result = new Uint8Array(maxBytes);
  let written = 0;
  for await (const chunk of decryptStream(
    resumable.stream,
    key,
    cryptoRecord.size,
    totalSize,
    cryptoRecord.exact,
  )) {
    const bytesToCopy = Math.min(chunk.length, maxBytes - written);
    result.set(chunk.subarray(0, bytesToCopy), written);
    written += bytesToCopy;
    if (written >= maxBytes) break;
  }

  return result.slice(0, written).buffer;
};

const removeFile = async (shareId: string, fileId: string) => {
  await api.delete(
    `shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}`,
  );
};

/**
 * Download a non-encrypted file with progress tracking and cancellation.
 * Uses fetch + ReadableStream when the browser can stream directly to disk.
 *
 * Chrome/Edge: File System Access API -> batched disk writes, bounded memory.
 * Other browsers: native navigation download, so the browser owns buffering
 * and large files are never accumulated in the page's JavaScript heap.
 */
const downloadFileWithProgress = async (
  shareId: string,
  fileId: string,
  fileName: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const canStreamToDisk =
    typeof window !== "undefined" && "showSaveFilePicker" in window;
  if (!canStreamToDisk) {
    await downloadFile(shareId, fileId);
    return;
  }

  // Start the request in parallel with the picker to hide initial network RTT.
  const downloadUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}`;
  const fetchPromise = fetchStreaming(downloadUrl, signal);

  // FSAA must be called in user gesture context (before async network ops)
  let writable: FileSystemWritableFileStream | null = null;
  let fileHandle: FileSystemFileHandle | null = null;
  try {
    fileHandle = await (window as any).showSaveFilePicker({
      suggestedName: fileName,
    });
    writable = await fileHandle!.createWritable();
  } catch (e: any) {
    try {
      (await fetchPromise).body?.cancel();
    } catch {
      /* ignored */
    }
    if (e.name === "AbortError") return;

    // A picker implementation can exist but still be unavailable (policy,
    // iframe, browser bug). Fall back to the browser's native download path.
    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    await downloadFile(shareId, fileId);
    return;
  }

  const response = await fetchPromise;
  const resumable = createResumableDownloadBody(downloadUrl, response, signal);
  const totalSize = resumable.totalSize;
  const reader = resumable.stream.getReader();
  let downloaded = 0;
  const progress = createDownloadProgressReporter(onProgress, totalSize);

  try {
    async function* responseChunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) return;
        downloaded += value.length;
        progress.update(downloaded);
        yield value;
      }
    }

    await writeDownloadChunksToDisk(responseChunks(), writable, signal);
    await writable.close();
    progress.complete(downloaded);
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      /* ignored */
    }
    // Supprime le fichier 0-octet stub créé par le picker
    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    try {
      reader.cancel();
    } catch {
      /* ignored */
    }
    throw e;
  }
};

/**
 * Téléchargement groupé E2E avec streaming :
 * - Déchiffre chaque fichier en streaming (1 chunk en mémoire à la fois)
 * - Construit le ZIP en streaming via fflate Zip/ZipPassThrough
 * - Chrome/Edge : écrit le ZIP directement sur disque (FSAA)
 * - Firefox/Safari : accumule les fragments ZIP en Blob parts
 *
 * Peak mémoire : ~taille du plus gros fichier (pendant son déchiffrement)
 * + sortie ZIP progressive.  Vs ancien code : ~somme de tous les fichiers x2.
 */
const downloadAllAsZipE2E = async (
  shareId: string,
  files: FileMetaData[],
  encodedKey: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  // Démarre la préparation crypto + la première requête EN PARALLÈLE de
  // l'ouverture du file picker pour masquer la latence réseau initiale.
  const keyPromise = importKeyFromBase64(encodedKey);
  const chunkSizePromise = getChunkSize();
  const firstFetchPromise: Promise<Response | null> =
    files.length > 0
      ? fetchStreaming(
          `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(files[0].id)}`,
          signal,
        )
      : Promise.resolve(null);

  // Try FSAA for streaming zip to disk
  let writable: FileSystemWritableFileStream | null = null;
  let fileHandle: FileSystemFileHandle | null = null;
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: `${shareId}.zip`,
      });
      writable = await fileHandle!.createWritable();
    } catch (e: any) {
      if (e.name === "AbortError") {
        // Annulation utilisateur : libérer la requête en vol
        try {
          (await firstFetchPromise)?.body?.cancel();
        } catch {
          /* ignored */
        }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const key = await keyPromise;
  const chunkSize = await chunkSizePromise;

  // Total octets pour jauge byte-level (taille ciphertext)
  const totalBytes = files.reduce(
    (s, f) => s + (f.size ? parseInt(f.size) : 0),
    0,
  );
  let downloadedBytes = 0;
  const progress = createDownloadProgressReporter(onProgress, totalBytes);

  // Chain of write promises for async zip.ondata -> writable
  let writeChain = Promise.resolve();
  const blobParts: BlobPart[] = [];

  const zip = new Zip();
  zip.ondata = (_err, data, _final) => {
    // fflate may reuse internal buffers -- always copy
    const copy = new Uint8Array(data);
    if (writable) {
      writeChain = writeChain.then(() => writable!.write(copy));
    } else {
      blobParts.push(copy);
    }
  };

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(file.id)}`;
      const response =
        i === 0
          ? (await firstFetchPromise)!
          : await fetchStreaming(fileUrl, signal);
      const resumable = createResumableDownloadBody(fileUrl, response, signal);
      const totalSize = resumable.totalSize;
      const cryptoRecord = getEncryptionRecordConfig(response, chunkSize);

      // Compte les octets chiffrés au passage pour la progression globale
      const body = onProgress
        ? resumable.stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                downloadedBytes += chunk.length;
                progress.update(downloadedBytes);
                controller.enqueue(chunk);
              },
            }),
          )
        : resumable.stream;

      // level 0 = store (no compression) -- data is encrypted, incompressible
      const entry = new ZipPassThrough(getSafeZipEntryName(file));
      zip.add(entry);

      for await (const chunk of decryptStream(
        body,
        key,
        cryptoRecord.size,
        totalSize,
        cryptoRecord.exact,
      )) {
        entry.push(chunk, false);
      }
      entry.push(new Uint8Array(0), true);
    }

    zip.end();

    if (writable) {
      await writeChain;
      await writable.close();
    } else {
      const blob = new Blob(blobParts, { type: "application/zip" });
      downloadDecryptedBlob(blob, `${shareId}.zip`);
    }
    progress.complete(downloadedBytes);
  } catch (e) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        /* ignored */
      }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    throw e;
  }
};

const uploadFile = async (
  shareId: string,
  chunk: Blob | ArrayBuffer,
  file: {
    id?: string;
    name: string;
    uploadRelativePath?: string;
    relativePath?: string;
  },
  chunkIndex: number,
  totalChunks: number,
): Promise<FileUploadResponse> => {
  // Use native fetch instead of axios (XMLHttpRequest) to avoid the
  // Chromium file-descriptor leak that causes SIGILL after ~800-1000
  // XHR-based chunk uploads on Linux.
  //
  // IMPORTANT FOR MEMORY: this function is called 1 000-2 000 times
  // for large uploads.  V8 keeps the full async-function activation
  // record alive until the returned Promise settles AND the caller
  // drops the reference.  Every local variable (controller, params,
  // response, url string, etc.) is retained.  To minimise pressure
  // we:
  //   1. Build the URL synchronously and drop URLSearchParams early
  //   2. Abort the controller right after reading the response to
  //      detach fetch-internal listeners immediately
  //   3. Null-out locals that are no longer needed

  let url = `/api/shares/${apiPathSegment(shareId)}/files?`;
  url += `name=${encodeURIComponent(file.name)}`;
  url += `&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`;
  if (file.id) url += `&id=${encodeURIComponent(file.id)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min

  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        ...((file.uploadRelativePath || file.relativePath) && {
          "X-File-Relative-Path": encodeURIComponent(
            file.uploadRelativePath || file.relativePath!,
          ),
        }),
      },
      body: chunk,
      credentials: "include",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const httpStatus = response.status;
      let data: any = null;
      try {
        data = await response.json();
      } catch {
        // body may not be JSON -- explicitly release the stream so the
        // browser can free the network buffer immediately.
        response.body?.cancel();
      }
      // Detach signal from fetch internals
      controller.abort();
      response = undefined;
      const err: any = new Error(`Upload chunk ${chunkIndex} failed`);
      err.status = httpStatus;
      err.data = data;
      throw err;
    }

    const result = (await response.json()) as FileUploadResponse;

    // Immediately detach the abort signal from fetch internals.
    // Without this, Chromium keeps the AbortController + Signal +
    // internal listener alive until GC.
    controller.abort();
    response = undefined;

    return result;
  } catch (e: any) {
    clearTimeout(timeout);
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
    response = undefined;

    // Re-attach HTTP status for non-ok responses (the error path
    // above already sets it; this handles network/abort errors).
    if (!e.status && e.name === "AbortError") {
      e.status = 0;
    }
    throw e;
  }
};

const createReverseShare = async (reverseShare: CreateReverseShare) => {
  return (await api.post("reverseShares", reverseShare)).data;
};

/**
 * Upload a re-encrypted chunk to replace an existing file.
 * Uses PUT /shares/:shareId/files/:fileId/reencrypt.
 */
const uploadReencryptChunk = async (
  shareId: string,
  fileId: string,
  chunk: ArrayBuffer,
  chunkIndex: number,
  totalChunks: number,
  rotationId?: string,
  encryptionChunkSize?: number,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<void> => {
  let url = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(fileId)}/reencrypt?`;
  url += `chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`;
  if (rotationId) url += `&rotationId=${encodeURIComponent(rotationId)}`;
  if (encryptionChunkSize) {
    url += `&encryptionChunkSize=${encryptionChunkSize}`;
  }
  if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`;

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 900_000);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      credentials: "include",
      signal: controller.signal,
    });

    if (!response.ok) {
      const httpStatus = response.status;
      let data: any = null;
      try {
        data = await response.json();
      } catch {
        await response.body?.cancel();
      }
      response = undefined;
      const err: any = new Error(`Reencrypt chunk ${chunkIndex} failed`);
      err.status = httpStatus;
      err.data = data;
      throw err;
    }

    // Fully consume the empty NestJS response. Aborting a successful fetch
    // here accumulates AbortEvent work in Chromium during very large rotations
    // and can reset a request whose final bytes are still being flushed.
    await response.arrayBuffer();
    response = undefined;
  } catch (e: any) {
    if (timedOut && e?.name === "AbortError") {
      const timeoutError: any = new Error(
        `Reencrypt chunk ${chunkIndex} timed out`,
      );
      timeoutError.status = 0;
      throw timeoutError;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
    response = undefined;
  }
};

const getMyReverseShares = async (): Promise<MyReverseShare[]> => {
  return (await api.get("reverseShares")).data;
};

const getReverseShare = async (
  reverseShareToken: string,
): Promise<ReverseShare> => {
  const { data } = await api.get(
    `/reverseShares/${apiPathSegment(reverseShareToken)}`,
  );
  setCookie("reverse_share_token", reverseShareToken);
  return data;
};

const removeReverseShare = async (id: string) => {
  await api.delete(`/reverseShares/${apiPathSegment(id)}`);
};

const updateReverseShare = async (
  id: string,
  data: { shareExpiration?: string; encryptedReverseShareKey?: string },
) => {
  await api.patch(`/reverseShares/${apiPathSegment(id)}`, data);
};

/**
 * Fetch the encrypted reverse share key (K_rs wrapped by K_master)
 * for E2E reverse share decryption. Requires authenticated user = RS creator.
 *
 * NOTE: The share page now reads encryptedReverseShareKey directly from the
 * share data (GET /shares/:id). This function is kept for external API clients.
 * Errors are propagated -- callers must handle them.
 */
const getEncryptedE2eKey = async (shareId: string): Promise<string | null> => {
  const { data } = await api.get(`/shares/${apiPathSegment(shareId)}/e2e-key`);
  return data?.encryptedReverseShareKey ?? null;
};

/**
 * Télécharge le ZIP global préparé par le serveur (non-E2E) en streaming
 * avec progression en octets et annulation via AbortSignal.
 *
 * Sans File System Access API, délègue le téléchargement au navigateur pour
 * ne jamais accumuler un ZIP potentiellement énorme dans le heap JavaScript.
 */
const downloadAllAsZip = async (
  shareId: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const canStreamToDisk =
    typeof window !== "undefined" && "showSaveFilePicker" in window;
  if (!canStreamToDisk) {
    window.location.assign(
      new URL(
        `/api/shares/${apiPathSegment(shareId)}/files/zip`,
        window.location.origin,
      ).toString(),
    );
    return;
  }

  // Démarre la requête EN PARALLÈLE du file picker pour masquer la
  // latence réseau initiale (TCP/TLS + premier roundtrip).
  const fetchPromise = fetchStreaming(
    `/api/shares/${apiPathSegment(shareId)}/files/zip`,
    signal,
  );

  let writable: FileSystemWritableFileStream | null = null;
  let fileHandle: FileSystemFileHandle | null = null;
  try {
    fileHandle = await (window as any).showSaveFilePicker({
      suggestedName: `${shareId}.zip`,
    });
    writable = await fileHandle!.createWritable();
  } catch (e: any) {
    try {
      (await fetchPromise).body?.cancel();
    } catch {
      /* ignored */
    }
    if (e.name === "AbortError") return;

    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    window.location.assign(
      new URL(
        `/api/shares/${apiPathSegment(shareId)}/files/zip`,
        window.location.origin,
      ).toString(),
    );
    return;
  }

  const response = await fetchPromise;
  const totalSize = parseInt(response.headers.get("Content-Length") || "0");

  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  let downloaded = 0;
  const progress = createDownloadProgressReporter(onProgress, totalSize);

  try {
    async function* responseChunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) return;
        downloaded += value.length;
        progress.update(downloaded);
        yield value;
      }
    }

    await writeDownloadChunksToDisk(responseChunks(), writable, signal);
    await writable.close();
    progress.complete(downloaded);
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      /* ignored */
    }
    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    try {
      reader.cancel();
    } catch {
      /* ignored */
    }
    throw e;
  }
};

/**
 * Download a selection of files as a client-side ZIP (non-E2E).
 * Fetches each file via streaming, pipes through fflate, writes to disk
 * (FSAA) or downloads as Blob.
 */
const downloadSelectedAsZip = async (
  shareId: string,
  files: FileMetaData[],
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  // Première requête en parallèle du file picker
  const firstFetchPromise: Promise<Response | null> =
    files.length > 0
      ? fetchStreaming(
          `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(files[0].id)}`,
          signal,
        )
      : Promise.resolve(null);

  let writable: FileSystemWritableFileStream | null = null;
  let fileHandle: FileSystemFileHandle | null = null;
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: `${shareId}-selection.zip`,
      });
      writable = await fileHandle!.createWritable();
    } catch (e: any) {
      if (e.name === "AbortError") {
        try {
          (await firstFetchPromise)?.body?.cancel();
        } catch {
          /* ignored */
        }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const totalBytes = files.reduce(
    (s, f) => s + (f.size ? parseInt(f.size) : 0),
    0,
  );
  let downloadedBytes = 0;
  const progress = createDownloadProgressReporter(onProgress, totalBytes);

  let writeChain = Promise.resolve();
  const blobParts: BlobPart[] = [];

  const zip = new Zip();
  zip.ondata = (_err, data, _final) => {
    const copy = new Uint8Array(data);
    if (writable) {
      writeChain = writeChain.then(() => writable!.write(copy));
    } else {
      blobParts.push(copy);
    }
  };

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(file.id)}`;
      const response =
        i === 0
          ? (await firstFetchPromise)!
          : await fetchStreaming(fileUrl, signal);
      const resumable = createResumableDownloadBody(fileUrl, response, signal);

      const reader = resumable.stream.getReader();
      const entry = new ZipPassThrough(getSafeZipEntryName(file));
      zip.add(entry);

      let done = false;
      while (!done) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          downloadedBytes += result.value.length;
          progress.update(downloadedBytes);
          entry.push(result.value, false);
        }
      }
      entry.push(new Uint8Array(0), true);
    }

    zip.end();

    if (writable) {
      await writeChain;
      await writable.close();
    } else {
      const blob = new Blob(blobParts, { type: "application/zip" });
      downloadDecryptedBlob(blob, `${shareId}-selection.zip`);
    }
    progress.complete(downloadedBytes);
  } catch (e) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        /* ignored */
      }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    throw e;
  }
};

/**
 * Download a selection of E2E-encrypted files as a client-side ZIP.
 */
const downloadSelectedAsZipE2E = async (
  shareId: string,
  files: FileMetaData[],
  encodedKey: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const keyPromise = importKeyFromBase64(encodedKey);
  const chunkSizePromise = getChunkSize();
  const firstFetchPromise: Promise<Response | null> =
    files.length > 0
      ? fetchStreaming(
          `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(files[0].id)}`,
          signal,
        )
      : Promise.resolve(null);

  let writable: FileSystemWritableFileStream | null = null;
  let fileHandle: FileSystemFileHandle | null = null;
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: `${shareId}-selection.zip`,
      });
      writable = await fileHandle!.createWritable();
    } catch (e: any) {
      if (e.name === "AbortError") {
        try {
          (await firstFetchPromise)?.body?.cancel();
        } catch {
          /* ignored */
        }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const key = await keyPromise;
  const chunkSize = await chunkSizePromise;

  const totalBytes = files.reduce(
    (s, f) => s + (f.size ? parseInt(f.size) : 0),
    0,
  );
  let downloadedBytes = 0;
  const progress = createDownloadProgressReporter(onProgress, totalBytes);

  let writeChain = Promise.resolve();
  const blobParts: BlobPart[] = [];

  const zip = new Zip();
  zip.ondata = (_err, data, _final) => {
    const copy = new Uint8Array(data);
    if (writable) {
      writeChain = writeChain.then(() => writable!.write(copy));
    } else {
      blobParts.push(copy);
    }
  };

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileUrl = `/api/shares/${apiPathSegment(shareId)}/files/${apiPathSegment(file.id)}`;
      const response =
        i === 0
          ? (await firstFetchPromise)!
          : await fetchStreaming(fileUrl, signal);
      const resumable = createResumableDownloadBody(fileUrl, response, signal);
      const totalSize = resumable.totalSize;
      const cryptoRecord = getEncryptionRecordConfig(response, chunkSize);

      const body = onProgress
        ? resumable.stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                downloadedBytes += chunk.length;
                progress.update(downloadedBytes);
                controller.enqueue(chunk);
              },
            }),
          )
        : resumable.stream;

      const entry = new ZipPassThrough(getSafeZipEntryName(file));
      zip.add(entry);

      for await (const chunk of decryptStream(
        body,
        key,
        cryptoRecord.size,
        totalSize,
        cryptoRecord.exact,
      )) {
        entry.push(chunk, false);
      }
      entry.push(new Uint8Array(0), true);
    }

    zip.end();

    if (writable) {
      await writeChain;
      await writable.close();
    } else {
      const blob = new Blob(blobParts, { type: "application/zip" });
      downloadDecryptedBlob(blob, `${shareId}-selection.zip`);
    }
    progress.complete(downloadedBytes);
  } catch (e) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        /* ignored */
      }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try {
        await (fileHandle as any).remove();
      } catch {
        /* ignored */
      }
    }
    throw e;
  }
};

export default {
  list,
  removeFromAdminInventory,
  create,
  completeShare,
  keepUploadAlive,
  createBridgeUploadToken,
  revertComplete,
  getShareToken,
  get,
  getFromOwner,
  remove,
  getMetaData,
  doesFileSupportPreview,
  getMyShares,
  isShareIdAvailable,
  downloadFile,
  downloadFileE2E,
  downloadFileWithProgress,
  downloadAllAsZip,
  downloadAllAsZipE2E,
  downloadSelectedAsZip,
  downloadSelectedAsZipE2E,
  fetchDecryptedFile,
  fetchDecryptedFilePrefix,
  removeFile,
  uploadFile,
  uploadReencryptChunk,
  getReverseShare,
  createReverseShare,
  getMyReverseShares,
  removeReverseShare,
  updateReverseShare,
  getEncryptedE2eKey,
  getStoredRecipients,
};

export {
  resolveFileMimeType,
  fetchDecryptedFile,
  fetchDecryptedFilePrefix,
  downloadFileE2E,
  downloadAllAsZipE2E,
  downloadSelectedAsZip,
  downloadSelectedAsZipE2E,
};
