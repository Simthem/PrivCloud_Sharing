import { deleteCookie, setCookie } from "cookies-next";
import { Zip, ZipPassThrough } from "fflate";
import mime from "mime-types";
import { FileUploadResponse } from "../types/File.type";
import {
  decryptStream,
  downloadDecryptedBlob,
  importKeyFromBase64,
} from "../utils/crypto.util";
import { completeSafeLineChallenge } from "./api.service";
import { notifySafeLineChallenge } from "../utils/safeline-notify.util";
import { translateOutsideContext } from "../hooks/useTranslate.hook";

import {
  CreateReverseShare,
  CreateShare,
  MyReverseShare,
  MyShare,
  ReverseShare,
  Share,
  ShareMetaData,
} from "../types/share.type";
import { isTextBasedMimeType } from "../components/share/FilePreview";
import api from "./api.service";

const list = async (): Promise<MyShare[]> => {
  return (await api.get(`shares/all`)).data;
};

const create = async (share: CreateShare, isReverseShare = false) => {
  if (!isReverseShare) {
    deleteCookie("reverse_share_token");
  }
  return (await api.post("shares", share)).data;
};

const completeShare = async (id: string, e2eKey?: string) => {
  const response = (
    await api.post(`shares/${id}/complete`, e2eKey ? { e2eKey } : {})
  ).data;
  deleteCookie("reverse_share_token");
  return response;
};

const createBridgeUploadToken = async (
  id: string,
  label?: string,
): Promise<{ token: string; expiresAt: string }> => {
  return (await api.post(`shares/${id}/bridge-upload-token`, { label })).data;
};

const revertComplete = async (id: string) => {
  return (await api.delete(`shares/${id}/complete`)).data;
};

const get = async (id: string): Promise<Share> => {
  return (await api.get(`shares/${id}`)).data;
};

const getFromOwner = async (id: string): Promise<Share> => {
  return (await api.get(`shares/${id}/from-owner`)).data;
};

const getMetaData = async (id: string): Promise<ShareMetaData> => {
  return (await api.get(`shares/${id}/metaData`)).data;
};

const remove = async (id: string) => {
  await api.delete(`shares/${id}`);
};

const getMyShares = async (): Promise<MyShare[]> => {
  return (await api.get("shares")).data;
};

const getStoredRecipients = async (): Promise<Array<string>> => {
  return (await api.get("shares/recipients")).data;
};

const getShareToken = async (id: string, password?: string, captchaToken?: string) => {
  await api.post(`/shares/${id}/token`, {
    password,
    ...(captchaToken && { captchaToken }),
  });
};

const isShareIdAvailable = async (id: string): Promise<boolean> => {
  return (await api.get(`/shares/isShareIdAvailable/${id}`)).data.isAvailable;
};

// Seuil max pour la preview video E2E (dechiffrement complet en memoire).
// Les videos non-E2E sont streamees nativement par le navigateur, pas de limite.
const VIDEO_PREVIEW_MAX_SIZE_E2E = 100 * 1024 * 1024; // 100 MB

const doesFileSupportPreview = (
  fileName: string,
  options?: { fileSizeBytes?: number; isE2EEncrypted?: boolean },
) => {
  const mimeType = (mime.contentType(fileName) || "").split(";")[0];

  if (!mimeType) return false;

  if (mimeType.startsWith("video/")) {
    // En E2E, useDecryptedBlobUrl charge le fichier entier en memoire
    // pour le dechiffrer, ce qui fait OOM sur les grosses videos.
    if (options?.isE2EEncrypted && options?.fileSizeBytes != null) {
      return options.fileSizeBytes <= VIDEO_PREVIEW_MAX_SIZE_E2E;
    }
    return true;
  }

  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf" ||
    isTextBasedMimeType(mimeType)
  );
};

const downloadFile = async (shareId: string, fileId: string) => {
  window.location.href = `/api/shares/${shareId}/files/${fileId}`;
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

const fetchStreaming = async (url: string, signal?: AbortSignal): Promise<Response> => {
  const opts: RequestInit = {
    credentials: "include",
    mode: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/octet-stream",
      "X-Download-Stream": "1",
    },
    ...(signal && { signal }),
  };

  let _lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= MAX_468_RETRIES; attempt++) {
    const response = await fetch(url, opts);

    if (response.status !== 468) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    }

    // 468 -- SafeLine anti-bot challenge required
    _lastResponse = response;

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

/**
 * Télécharge un fichier chiffré E2E en streaming, le déchiffre chunk par
 * chunk côté client, puis écrit sur disque progressivement.
 *
 * - Chrome/Edge : File System Access API (showSaveFilePicker) -> écriture
 *   directe sur disque, peak mémoire ~1 chunk (5-200 MB).
 * - Firefox/Safari : accumulation des chunks déchiffrés en Blob parts
 *   puis téléchargement classique.  Peak mémoire ~1x taille fichier
 *   (vs ~2-3x avec l'approche ArrayBuffer monolithique).
 */
const downloadFileE2E = async (
  shareId: string,
  fileId: string,
  fileName: string,
  encodedKey: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const key = await importKeyFromBase64(encodedKey);
  const chunkSize = await getChunkSize();
  const mimeType = (
    mime.contentType(fileName) || "application/octet-stream"
  ).split(";")[0];

  // Démarre la requête EN PARALLÈLE du file picker pour masquer le RTT initial
  const fetchPromise = fetchStreaming(
    `/api/shares/${shareId}/files/${fileId}`,
    signal,
  );

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
        try { (await fetchPromise).body?.cancel(); } catch { /* ignored */ }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const response = await fetchPromise;
  const totalSize = parseInt(response.headers.get("Content-Length") || "0");

  if (!response.body) throw new Error("Response has no body");

  // Wrap stream with progress tracking when callback is provided.
  // TransformStream counts encrypted bytes as they flow to decryptStream.
  let body: ReadableStream<Uint8Array> = response.body;
  if (onProgress) {
    let bytesRead = 0;
    body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesRead += chunk.length;
          onProgress(bytesRead, totalSize);
          controller.enqueue(chunk);
        },
      }),
    );
  }

  if (writable) {
    // Streaming to disk -- peak: ~1 encrypted chunk + 1 decrypted chunk
    try {
      for await (const chunk of decryptStream(
        body, key, chunkSize, totalSize,
      )) {
        await writable.write(chunk as unknown as FileSystemWriteChunkType);
      }
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch { /* ignored */ }
      // Supprime le fichier 0-octet stub créé par le picker
      if (fileHandle && (fileHandle as any).remove) {
        try { await (fileHandle as any).remove(); } catch { /* ignored */ }
      }
      throw e;
    }
  } else {
    // Fallback: accumulate decrypted chunks into Blob parts.
    // Blob can be backed by disk internally, unlike ArrayBuffer.
    const parts: BlobPart[] = [];
    for await (const chunk of decryptStream(
      body, key, chunkSize, totalSize,
    )) {
      parts.push(new Uint8Array(chunk) as BlobPart);
    }
    const blob = new Blob(parts, { type: mimeType });
    downloadDecryptedBlob(blob, fileName);
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
): Promise<ArrayBuffer> => {
  const key = await importKeyFromBase64(encodedKey);
  const chunkSize = await getChunkSize();

  const response = await fetchStreaming(
    `/api/shares/${shareId}/files/${fileId}?download=false`,
  );
  const totalSize = parseInt(response.headers.get("Content-Length") || "0");

  if (!response.body) throw new Error("Response has no body");

  const parts: Uint8Array[] = [];
  let totalDecrypted = 0;
  for await (const chunk of decryptStream(
    response.body, key, chunkSize, totalSize,
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

const removeFile = async (shareId: string, fileId: string) => {
  await api.delete(`shares/${shareId}/files/${fileId}`);
};

/**
 * Download a non-encrypted file with progress tracking and cancellation.
 * Uses fetch + ReadableStream instead of window.location.href to enable
 * byte-level progress reporting and AbortSignal cancellation.
 *
 * Chrome/Edge: File System Access API → streaming to disk, minimal memory.
 * Firefox/Safari: Blob accumulation → requires ~1x file size in memory.
 */
const downloadFileWithProgress = async (
  shareId: string,
  fileId: string,
  fileName: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const mimeType = (
    mime.contentType(fileName) || "application/octet-stream"
  ).split(";")[0];

  // Démarre la requête EN PARALLÈLE du file picker pour masquer le RTT initial
  const fetchPromise = fetchStreaming(
    `/api/shares/${shareId}/files/${fileId}`,
    signal,
  );

  // FSAA must be called in user gesture context (before async network ops)
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
        try { (await fetchPromise).body?.cancel(); } catch { /* ignored */ }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const response = await fetchPromise;
  const totalSize = parseInt(response.headers.get("Content-Length") || "0");

  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let downloaded = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      onProgress?.(downloaded, totalSize);
      if (writable) {
        await writable.write(value);
      } else {
        parts.push(new Uint8Array(value));
      }
    }
    if (writable) {
      await writable.close();
    } else {
      const blob = new Blob(parts, { type: mimeType });
      // cwe:ignore DOMXSS - href is a local blob: URL (URL.createObjectURL), not remote HTML.
      // Filename is sanitized inside downloadDecryptedBlob (strips path separators).
      downloadDecryptedBlob(blob, fileName);
    }
  } catch (e) {
    if (writable) {
      try { await writable.abort(); } catch { /* ignored */ }
    }
    // Supprime le fichier 0-octet stub créé par le picker
    if (fileHandle && (fileHandle as any).remove) {
      try { await (fileHandle as any).remove(); } catch { /* ignored */ }
    }
    try { reader.cancel(); } catch { /* ignored */ }
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
  files: { id: string; name: string; size?: string }[],
  encodedKey: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  // Démarre la préparation crypto + la première requête EN PARALLÈLE de
  // l'ouverture du file picker pour masquer la latence réseau initiale.
  const keyPromise = importKeyFromBase64(encodedKey);
  const chunkSizePromise = getChunkSize();
  const firstFetchPromise: Promise<Response | null> = files.length > 0
    ? fetchStreaming(`/api/shares/${shareId}/files/${files[0].id}`, signal)
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
        try { (await firstFetchPromise)?.body?.cancel(); } catch { /* ignored */ }
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
      const response = i === 0
        ? (await firstFetchPromise)!
        : await fetchStreaming(
            `/api/shares/${shareId}/files/${file.id}`,
            signal,
          );
      const totalSize = parseInt(response.headers.get("Content-Length") || "0");

      if (!response.body) throw new Error(`No body for ${file.name}`);

      // Compte les octets chiffrés au passage pour la progression globale
      const body = onProgress
        ? response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                downloadedBytes += chunk.length;
                onProgress(downloadedBytes, totalBytes);
                controller.enqueue(chunk);
              },
            }),
          )
        : response.body;

      // level 0 = store (no compression) -- data is encrypted, incompressible
      const entry = new ZipPassThrough(file.name);
      zip.add(entry);

      for await (const chunk of decryptStream(
        body, key, chunkSize, totalSize,
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
  } catch (e) {
    if (writable) {
      try { await writable.abort(); } catch { /* ignored */ }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try { await (fileHandle as any).remove(); } catch { /* ignored */ }
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

  let url = `/api/shares/${encodeURIComponent(shareId)}/files?`;
  url += `name=${encodeURIComponent(file.name)}`;
  url += `&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`;
  if (file.id) url += `&id=${encodeURIComponent(file.id)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min

  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
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
    try { controller.abort(); } catch { /* already aborted */ }
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
): Promise<void> => {
  let url = `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}/reencrypt?`;
  url += `chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      credentials: "include",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const httpStatus = response.status;
      let data: any = null;
      try { data = await response.json(); } catch { response.body?.cancel(); }
      controller.abort();
      response = undefined;
      const err: any = new Error(`Reencrypt chunk ${chunkIndex} failed`);
      err.status = httpStatus;
      err.data = data;
      throw err;
    }
    controller.abort();
    response = undefined;
  } catch (e: any) {
    clearTimeout(timeout);
    try { controller.abort(); } catch { /* already aborted */ }
    response = undefined;
    throw e;
  }
};

const getMyReverseShares = async (): Promise<MyReverseShare[]> => {
  return (await api.get("reverseShares")).data;
};

const getReverseShare = async (
  reverseShareToken: string,
): Promise<ReverseShare> => {
  const { data } = await api.get(`/reverseShares/${reverseShareToken}`);
  setCookie("reverse_share_token", reverseShareToken);
  return data;
};

const removeReverseShare = async (id: string) => {
  await api.delete(`/reverseShares/${id}`);
};

const updateReverseShare = async (
  id: string,
  data: { shareExpiration?: string; encryptedReverseShareKey?: string },
) => {
  await api.patch(`/reverseShares/${id}`, data);
};

/**
 * Fetch the encrypted reverse share key (K_rs wrapped by K_master)
 * for E2E reverse share decryption. Requires authenticated user = RS creator.
 *
 * NOTE: The share page now reads encryptedReverseShareKey directly from the
 * share data (GET /shares/:id). This function is kept for external API clients.
 * Errors are propagated -- callers must handle them.
 */
const getEncryptedE2eKey = async (
  shareId: string,
): Promise<string | null> => {
  const { data } = await api.get(`/shares/${shareId}/e2e-key`);
  return data?.encryptedReverseShareKey ?? null;
};

/**
 * Télécharge le ZIP global préparé par le serveur (non-E2E) en streaming
 * avec progression en octets et annulation via AbortSignal.
 *
 * Remplace l'ancien `window.location.href = /api/shares/:id/files/zip`
 * qui ne permettait ni jauge ni annulation.
 */
const downloadAllAsZip = async (
  shareId: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  // Démarre la requête EN PARALLÈLE du file picker pour masquer la
  // latence réseau initiale (TCP/TLS + premier roundtrip).
  const fetchPromise = fetchStreaming(
    `/api/shares/${shareId}/files/zip`,
    signal,
  );

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
        try { (await fetchPromise).body?.cancel(); } catch { /* ignored */ }
        return;
      }
      writable = null;
      fileHandle = null;
    }
  }

  const response = await fetchPromise;
  const totalSize = parseInt(response.headers.get("Content-Length") || "0");

  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let downloaded = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      onProgress?.(downloaded, totalSize);
      if (writable) {
        await writable.write(value);
      } else {
        parts.push(new Uint8Array(value));
      }
    }
    if (writable) {
      await writable.close();
    } else {
      const blob = new Blob(parts, { type: "application/zip" });
      // cwe:ignore DOMXSS - href is a local blob: URL (URL.createObjectURL), not remote HTML.
      downloadDecryptedBlob(blob, `${shareId}.zip`);
    }
  } catch (e) {
    if (writable) {
      try { await writable.abort(); } catch { /* ignored */ }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try { await (fileHandle as any).remove(); } catch { /* ignored */ }
    }
    try { reader.cancel(); } catch { /* ignored */ }
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
  files: { id: string; name: string; size?: string }[],
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  // Première requête en parallèle du file picker
  const firstFetchPromise: Promise<Response | null> = files.length > 0
    ? fetchStreaming(`/api/shares/${shareId}/files/${files[0].id}`, signal)
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
        try { (await firstFetchPromise)?.body?.cancel(); } catch { /* ignored */ }
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
      const response = i === 0
        ? (await firstFetchPromise)!
        : await fetchStreaming(
            `/api/shares/${shareId}/files/${file.id}`,
            signal,
          );
      if (!response.body) throw new Error(`No body for ${file.name}`);

      const reader = response.body.getReader();
      const entry = new ZipPassThrough(file.name);
      zip.add(entry);

      let done = false;
      while (!done) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          downloadedBytes += result.value.length;
          onProgress?.(downloadedBytes, totalBytes);
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
  } catch (e) {
    if (writable) {
      try { await writable.abort(); } catch { /* ignored */ }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try { await (fileHandle as any).remove(); } catch { /* ignored */ }
    }
    throw e;
  }
};

/**
 * Download a selection of E2E-encrypted files as a client-side ZIP.
 */
const downloadSelectedAsZipE2E = async (
  shareId: string,
  files: { id: string; name: string; size?: string }[],
  encodedKey: string,
  onProgress?: (_downloadedBytes: number, _totalBytes: number) => void,
  signal?: AbortSignal,
) => {
  const keyPromise = importKeyFromBase64(encodedKey);
  const chunkSizePromise = getChunkSize();
  const firstFetchPromise: Promise<Response | null> = files.length > 0
    ? fetchStreaming(`/api/shares/${shareId}/files/${files[0].id}`, signal)
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
        try { (await firstFetchPromise)?.body?.cancel(); } catch { /* ignored */ }
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
      const response = i === 0
        ? (await firstFetchPromise)!
        : await fetchStreaming(
            `/api/shares/${shareId}/files/${file.id}`,
            signal,
          );
      const totalSize = parseInt(response.headers.get("Content-Length") || "0");
      if (!response.body) throw new Error(`No body for ${file.name}`);

      const body = onProgress
        ? response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                downloadedBytes += chunk.length;
                onProgress(downloadedBytes, totalBytes);
                controller.enqueue(chunk);
              },
            }),
          )
        : response.body;

      const entry = new ZipPassThrough(file.name);
      zip.add(entry);

      for await (const chunk of decryptStream(
        body, key, chunkSize, totalSize,
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
  } catch (e) {
    if (writable) {
      try { await writable.abort(); } catch { /* ignored */ }
    }
    if (fileHandle && (fileHandle as any).remove) {
      try { await (fileHandle as any).remove(); } catch { /* ignored */ }
    }
    throw e;
  }
};

export default {
  list,
  create,
  completeShare,
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

export { fetchDecryptedFile, downloadFileE2E, downloadAllAsZipE2E, downloadSelectedAsZip, downloadSelectedAsZipE2E };
