import { showNotification } from "@mantine/notifications";
import { createElement } from "react";
import { completeSafeLineChallenge } from "../services/api.service";
import { notifySafeLineChallenge } from "./safeline-notify.util";
import { translateOutsideContext } from "../hooks/useTranslate.hook";

// --- Adaptive chunk sizing ---
const ADAPTIVE_MIN_CHUNK = 5_000_000; // 5 MB floor
const ADAPTIVE_MAX_CHUNK = 200_000_000; // 200 MB ceiling
const TARGET_CHUNK_SECONDS = 3; // aim for ~3 s per chunk
const PROBE_SMALL = 2_000_000; // 2 MB  -- phase 1 (fast networks have high overhead-to-data ratio)
const PROBE_LARGE = 16_000_000; // 16 MB -- phase 2 (only if phase 1 suggests > 10 MB/s)
const PROBE_FAST_THRESHOLD = 10_000_000; // 10 MB/s -- trigger phase 2

/**
 * POST a zero-filled payload to /api/probe and return bytes/sec.
 * Returns 0 on error so the caller falls back to the config default.
 */
async function runProbe(size: number): Promise<number> {
  const payload = new Uint8Array(size);
  const start = performance.now();
  try {
    const resp = await fetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
      credentials: "include",
    });
    resp.body?.cancel();
  } catch {
    return 0;
  }
  const elapsed = (performance.now() - start) / 1000;
  if (elapsed <= 0) return 0;
  return size / elapsed;
}

/**
 * Measure upload bandwidth with a two-phase probe:
 *  1) Small 2 MB probe -- fast and sufficient for slow connections.
 *  2) If phase 1 suggests > 30 MB/s, a second 16 MB probe gives a
 *     much more accurate measurement on fast links where the fixed
 *     overhead (TLS, latency) dominates the tiny transfer time.
 *
 * Returns bytes/sec. Falls back to 0 on error (caller uses config default).
 */
export async function measureBandwidth(): Promise<number> {
  const bw1 = await runProbe(PROBE_SMALL);
  if (bw1 <= 0) return 0;
  if (bw1 < PROBE_FAST_THRESHOLD) return bw1;
  // Fast link detected -- run a larger probe for accuracy
  const bw2 = await runProbe(PROBE_LARGE);
  return bw2 > 0 ? bw2 : bw1;
}

/**
 * Derive optimal chunk size from measured bandwidth.
 * Clamped to [ADAPTIVE_MIN_CHUNK, ADAPTIVE_MAX_CHUNK].
 * Returns 0 if probe failed (caller should use config default).
 */
const CHUNK_QUANT = 5_000_000; // quantize to 5 MB steps for reliable decryption

export function computeAdaptiveChunkSize(bandwidthBps: number): number {
  if (bandwidthBps <= 0) return 0;
  const raw = bandwidthBps * TARGET_CHUNK_SECONDS;
  const clamped = Math.min(
    ADAPTIVE_MAX_CHUNK,
    Math.max(ADAPTIVE_MIN_CHUNK, raw),
  );
  // Round to nearest CHUNK_QUANT so decryptFileAuto can find it
  return Math.round(clamped / CHUNK_QUANT) * CHUNK_QUANT;
}

/**
 * Measure bandwidth and return the effective chunk size.
 * The admin-configured baseChunkSize acts as the CEILING (not floor)
 * so slow connections get smaller chunks while fast connections use
 * the full admin size.  The adaptive probe can only LOWER the chunk
 * size, never raise it above the admin setting.
 */
export async function getAdaptiveChunkSize(
  baseChunkSize: number,
): Promise<number> {
  const bandwidth = await measureBandwidth();
  const adaptive = computeAdaptiveChunkSize(bandwidth);
  return adaptive > 0 ? Math.min(adaptive, baseChunkSize) : baseChunkSize;
}

// --- Upload Worker with batch recycling ---
const UPLOAD_BATCH_SIZE = 200;

/**
 * Run a single batch [startChunk, endChunk) in a fresh Worker.
 */
function runWorkerBatch(
  file: File | Blob,
  shareId: string,
  chunkSize: number,
  totalChunks: number,
  isE2E: boolean,
  cryptoKeyRaw: ArrayBuffer | null,
  startChunk: number,
  endChunk: number,
  fileId: string | undefined,
  fileName: string,
  onProgress: (
    chunkIndex: number,
    totalChunks: number,
    fileId: string,
  ) => void,
  signal?: AbortSignal,
): Promise<{ fileId: string; nextChunk: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/upload-worker.js?v=" + Date.now());

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      worker.terminate();
    };

    const onAbort = () => {
      worker.postMessage({ type: "abort" });
      cleanup();
      const err: any = new Error("Upload cancelled");
      err.cancelled = true;
      reject(err);
    };

    if (signal?.aborted) {
      worker.terminate();
      const err: any = new Error("Upload cancelled");
      err.cancelled = true;
      reject(err);
      return;
    }

    signal?.addEventListener("abort", onAbort);

    const onMsg = async (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.type) {
        case "progress":
          onProgress(msg.chunkIndex, msg.totalChunks, msg.fileId);
          break;

        case "batch-complete":
          cleanup();
          resolve({ fileId: msg.fileId, nextChunk: msg.nextChunk });
          break;

        case "error":
          cleanup();
          {
            const err: any = new Error(msg.message);
            err.status = msg.status;
            err.data = msg.data;
            reject(err);
          }
          break;

        case "quota-exceeded":
          cleanup();
          {
            const err: any = new Error(msg.message);
            err.status = 403;
            err.quota = true;
            reject(err);
          }
          break;

        case "need-safeline-challenge":
          try {
            await completeSafeLineChallenge();
            worker.postMessage({ type: "safeline-resolved" });
          } catch {
            // iframe challenge failed -- tell Worker so it exits the
            // wait loop immediately and falls through to backoff.
            worker.postMessage({ type: "safeline-failed" });
          }
          break;

        case "safeline-failed-show-notification": {
          const origin = window.location.origin;
          const t = translateOutsideContext();
          const link = createElement(
            "a",
            {
              href: origin,
              target: "_blank",
              rel: "noopener noreferrer",
              style: { color: "#1c7ed6", textDecoration: "underline" },
            },
            t("safeline.notify.link"),
          );
          showNotification({
            id: "safeline-upload-challenge",
            title: t("safeline.notify.title"),
            message: createElement(
              "span",
              null,
              t("safeline.notify.message", { link }),
            ),
            color: "orange",
            autoClose: false,
          });
          // Cross-tab alert: OS notification + audio beep + title flash
          // so the user is alerted even if they're on another tab.
          notifySafeLineChallenge();
          break;
        }

        case "token-refreshed":
          break;
      }
    };

    const onErr = (err: ErrorEvent) => {
      cleanup();
      reject(new Error("Upload worker crashed: " + (err.message || err)));
    };

    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);

    worker.postMessage({
      type: "start",
      shareId,
      file,
      chunkSize,
      totalChunks,
      isE2E,
      cryptoKeyRaw,
      startChunk,
      endChunk,
      fileId,
      fileName,
    });
  });
}

/**
 * Upload a file via batch-recycled Workers.
 * Each batch of UPLOAD_BATCH_SIZE chunks runs in a fresh Worker
 * that is terminated after completion, bounding memory accumulation.
 */
export async function uploadFileViaWorker(
  file: File | Blob,
  shareId: string,
  chunkSize: number,
  totalChunks: number,
  isE2E: boolean,
  cryptoKey: CryptoKey | null,
  onProgress: (
    chunkIndex: number,
    totalChunks: number,
    fileId: string,
  ) => void,
  signal?: AbortSignal,
): Promise<string> {
  let cryptoKeyRaw: ArrayBuffer | null = null;
  if (isE2E && cryptoKey) {
    cryptoKeyRaw = await crypto.subtle.exportKey("raw", cryptoKey);
  }

  let fileId: string | undefined;
  let currentChunk = 0;

  while (currentChunk < totalChunks) {
    const batchEnd = Math.min(currentChunk + UPLOAD_BATCH_SIZE, totalChunks);

    const result = await runWorkerBatch(
      file,
      shareId,
      chunkSize,
      totalChunks,
      isE2E,
      cryptoKeyRaw,
      currentChunk,
      batchEnd,
      fileId,
      file instanceof File ? file.name : "blob",
      onProgress,
      signal,
    );

    fileId = result.fileId;
    currentChunk = result.nextChunk;
  }

  return fileId!;
}
