import { showNotification } from "@mantine/notifications";
import { createElement } from "react";
import { completeSafeLineChallenge } from "../services/api.service";
import { notifySafeLineChallenge } from "./safeline-notify.util";
import { translateOutsideContext } from "../hooks/useTranslate.hook";

// --- Adaptive chunk sizing ---
const ADAPTIVE_MIN_CHUNK = 5_000_000;   //   5 MB floor
const ADAPTIVE_MAX_CHUNK = 50_000_000;  //  50 MB ceiling
// S3 multipart hard limit: 10,000 parts per upload.
// We cap at 9,500 to leave headroom for retries of the same part number.
const MAX_S3_PARTS = 9_500;
// 200 MB chunks caused 500 errors on large uploads when SafeLine WAF or
// Nginx had body-size / timeout limits below 200 MB, causing the proxy to
// drop the request before NestJS received it (non-JSON 500 body), triggering
// a ~30-minute stall in the upload worker's retry loop.
// At 50 MB:
//   - Transfer time at 50 Mbps ≈ 8 s → well under every proxy timeout
//   - A 250 GB file uses ≤ 5 120 chunks (under the 9 500 cap)
//   - Per-chunk server overhead is the same; throughput slightly lower but
//     upload reliability is dramatically improved for clients on fast links
//     who previously hit proxy limits at 100-160 MB chunks.
// The backend bodyParser floor is 200 MB (main.ts rawLimit), so 50 MB chunks
// are accepted without any backend change.
//
// RAM requirement: Express buffers the full raw body per request.
// At 200 MB × 3 concurrent uploads ≈ 600 MB body parser buffers.
// Ensure the VM has ≥ 4 GB RAM and Node is launched with
// --max-old-space-size=3072 (or higher) to avoid OOM.
const TARGET_CHUNK_SECONDS = 3; // aim for ~3 s per chunk
const PROBE_SMALL = 2_000_000; // 2 MB  -- phase 1 (fast networks have high overhead-to-data ratio)
const PROBE_LARGE = 32_000_000; // 32 MB -- phase 2 (accurate on fast+high-latency links)
const PROBE_FAST_THRESHOLD = 10_000_000; // 10 MB/s -- trigger phase 2

const WORKER_CACHE_KEY = Math.random().toString(36).slice(2);

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
 * The result is always capped at ADAPTIVE_MAX_CHUNK (200 MB).
 * Each E2E chunk allocates 3 × chunkSize in C++ BackingStores
 * (plainBuf + ciphertext + combined).  At 200 MB that is 600 MB peak,
 * which is within Chrome's per-Worker V8 heap limit on 64-bit systems.
 * SIGILL risk is absent: we use a single Worker with no recycling.
 * GC yield: 200 MB takes ~3.6 s at 55 MB/s; V8 GC clears 600 MB in
 * ~150 ms - well within the network-I/O window.
 * For slow connections the adaptive probe shrinks below the admin default.
 */
export async function getAdaptiveChunkSize(
  baseChunkSize: number,
  fileSize?: number,
): Promise<number> {
  // Always cap at ADAPTIVE_MAX_CHUNK regardless of the admin-configured value.
  // If the probe fails we still enforce the cap to prevent OOM/SIGTRAP on
  // large uploads (the admin may have set a value > 50 MB which is unsafe).
  const hardCapped = Math.min(baseChunkSize, ADAPTIVE_MAX_CHUNK);
  const bandwidth = await measureBandwidth();
  const adaptive = computeAdaptiveChunkSize(bandwidth);
  let result = adaptive <= 0 ? hardCapped : adaptive;

  // --- S3 multipart safety floor ---
  // AWS S3 limits uploads to 10,000 parts.  For very large files, we MUST
  // use a chunk size large enough to stay under that limit, regardless of
  // bandwidth.  This is the #1 reason uploads of 160+ GB fail silently.
  // Formula: minChunkForFile = ceil(fileSize / MAX_S3_PARTS)
  // Example: 250 GB / 9500 = ~26.3 MB minimum.
  //          1 TB  / 9500 = ~105 MB minimum.
  if (fileSize && fileSize > 0) {
    const s3Floor = Math.ceil(fileSize / MAX_S3_PARTS);
    if (s3Floor > result) {
      // Quantize to CHUNK_QUANT for E2E decryption compatibility
      result = Math.ceil(s3Floor / CHUNK_QUANT) * CHUNK_QUANT;
    }
  }

  // Final safety: never go below ADAPTIVE_MIN_CHUNK, never above MAX
  return Math.min(ADAPTIVE_MAX_CHUNK, Math.max(ADAPTIVE_MIN_CHUNK, result));
}

// --- Single-Worker upload (no batch recycling) ---
// Worker.terminate() + immediate new Worker() caused SIGILL in Chrome's
// ThreadPoolForeground: V8 concurrent GC tasks for the old isolate were
// still queued on the ThreadPool when the new Worker started allocating,
// and they accessed a partially-destroyed V8 heap -> UD2 -> SIGILL.
// Fix: one Worker handles the full upload [0, totalChunks).
// Memory safety: peak BackingStore = 3 × chunkSize (≤ 600 MB at 200 MB chunks).
// GC yield: await fetch() suspends the Worker for the full network transit
// (~3.6 s at 200 MB / 55 MB/s), giving V8 concurrent GC ~3.4 s to reclaim
// 600 MB of BackingStores.  V8 GC runs at ~4 GB/s → needs ~150 ms.  Safe.

/**
 * Run the upload [startChunk, endChunk) in a single persistent Worker.
 * The Worker is never recycled mid-upload; GC safety relies on the natural
 * yield provided by network I/O awaits (several seconds per large chunk).
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
  relativePath: string | undefined,
  onProgress: (
    _chunkIndex: number,
    _totalChunks: number,
    _fileId: string,
  ) => void,
  signal?: AbortSignal,
): Promise<{ fileId: string; nextChunk: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/upload-worker.js?v=" + WORKER_CACHE_KEY);

    // ---- Shared token refresh logic ----
    // Both the proactive keepalive and the worker's need-token-refresh
    // handler use this function.  A single in-flight promise is shared
    // to prevent two concurrent POST /api/auth/token calls that would
    // race on the rotation: the second caller would send the already-
    // deleted old refresh token and receive a 401.
    let refreshInFlight: Promise<boolean> | null = null;

    const doTokenRefresh = (): Promise<boolean> => {
      if (refreshInFlight) return refreshInFlight;
      const p = (async (): Promise<boolean> => {
        const attempt = async (): Promise<"done" | "failed" | "retry"> => {
          try {
            const resp = await fetch("/api/auth/token", {
              method: "POST",
              credentials: "include",
            });
            if (resp.ok) return "done";
            if (resp.status === 429) return "retry";
            if (resp.status === 468) {
              try {
                await completeSafeLineChallenge();
                const retry = await fetch("/api/auth/token", {
                  method: "POST",
                  credentials: "include",
                });
                return retry.ok ? "done" : "failed";
              } catch {
                return "failed";
              }
            }
            return "failed";
          } catch {
            return "retry";
          }
        };
        let result: "done" | "failed" | "retry" = "retry";
        for (let i = 0; i < 3 && result === "retry"; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 5000 * Math.pow(2, i - 1)));
          result = await attempt();
        }
        // Release the slot ~100 ms after completion so rapid callers
        // reuse the result instead of firing a duplicate request.
        setTimeout(() => { refreshInFlight = null; }, 100);
        return result === "done";
      })();
      refreshInFlight = p;
      return p;
    };

    // Proactive token refresh: fires every 10 min to rotate the
    // access_token before its 13-min cookie maxAge expires browser-side.
    // This prevents "chunk gets 401 → worker requests refresh → refresh
    // itself gets 401 because the token was never refreshed" scenarios on
    // long uploads (large .vmdk, .iso, etc.).
    const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min
    const proactiveRefreshTimer = setInterval(() => {
      doTokenRefresh().catch(() => {});
    }, TOKEN_REFRESH_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(proactiveRefreshTimer);
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

        case "need-token-refresh":
          // Safari does NOT send HttpOnly cookies in fetch() from Web Workers
          // (long-standing WebKit bug).  The main thread, which has full
          // cookie access, performs the refresh and notifies the Worker.
          // Uses the shared doTokenRefresh() to deduplicate any concurrent
          // proactive refresh that may already be in-flight.
          {
            const ok = await doTokenRefresh();
            worker.postMessage({
              type: ok ? "token-refresh-done" : "token-refresh-failed",
            });
          }
          break;

        case "need-safeline-challenge":
          try {
            await completeSafeLineChallenge();
            // Small delay: let SafeLine propagate the session cookie
            // to its edge nodes before the next chunk is sent.
            await new Promise((r) => setTimeout(r, 2000));
            worker.postMessage({ type: "safeline-resolved" });
          } catch {
            // Challenge failed (popup blocked or timeout).
            // Tell Worker so it exits the wait loop and falls through
            // to the backoff / notification flow.
            worker.postMessage({ type: "safeline-failed" });
          }
          break;

        case "safeline-failed-show-notification": {
          const t = translateOutsideContext();
          // Render a clickable button that opens the challenge popup and
          // signals the Worker once the session is confirmed valid.
          // This click IS a user interaction, so the popup won't be blocked.
          const retryBtn = createElement(
            "button",
            {
              style: {
                color: "#1c7ed6",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textDecoration: "underline",
                font: "inherit",
              },
              onClick: async () => {
                try {
                  await completeSafeLineChallenge();
                  // Session confirmed valid - give SafeLine a moment to
                  // propagate, then resume the worker.
                  await new Promise((r) => setTimeout(r, 1500));
                  worker.postMessage({ type: "safeline-resolved" });
                } catch {
                  worker.postMessage({ type: "safeline-failed" });
                }
              },
            },
            t("safeline.notify.link"),
          );
          showNotification({
            id: "safeline-upload-challenge",
            title: t("safeline.notify.title"),
            message: createElement(
              "span",
              null,
              t("safeline.notify.message", { link: retryBtn }),
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

        case "retrying": {
          const t = translateOutsideContext();
          const delaySec = Math.round(msg.delayMs / 1000);
          showNotification({
            id: "upload-chunk-retry",
            title: t("upload.notify.retrying.title"),
            message: t("upload.notify.retrying.message", {
              chunk: msg.chunkIndex,
              attempt: msg.attempt,
              max: msg.maxAttempts,
              delay: delaySec,
            }),
            color: "yellow",
            autoClose: 10000,
          });
          break;
        }

        case "recovery": {
          const t = translateOutsideContext();
          const pauseSec = Math.round(msg.pauseMs / 1000);
          showNotification({
            id: "upload-recovery-mode",
            title: t("upload.notify.recovery.title"),
            message: t("upload.notify.recovery.message", {
              attempt: msg.attempt,
              max: msg.maxAttempts,
              pause: pauseSec,
            }),
            color: "orange",
            autoClose: false,
          });
          break;
        }
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
      relativePath,
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
    _chunkIndex: number,
    _totalChunks: number,
    _fileId: string,
  ) => void,
  signal?: AbortSignal,
  relativePath?: string,
): Promise<string> {
  let cryptoKeyRaw: ArrayBuffer | null = null;
  if (isE2E && cryptoKey) {
    cryptoKeyRaw = await crypto.subtle.exportKey("raw", cryptoKey);
  }

  let fileId: string | undefined;

  // Single Worker for the entire upload: no batch recycling.
  // See UPLOAD_BATCH_SIZE comment above for the SIGILL root cause.
  const result = await runWorkerBatch(
    file,
    shareId,
    chunkSize,
    totalChunks,
    isE2E,
    cryptoKeyRaw,
    0,
    totalChunks,
    fileId,
    file instanceof File ? file.name : "blob",
    relativePath,
    onProgress,
    signal,
  );

  fileId = result.fileId;
  return fileId!;
}
