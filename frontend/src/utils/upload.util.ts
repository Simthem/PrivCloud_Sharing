import { showNotification } from "@mantine/notifications";
import { createElement } from "react";
import { completeSafeLineChallenge } from "../services/api.service";
import { notifySafeLineChallenge } from "./safeline-notify.util";
import { translateOutsideContext } from "../hooks/useTranslate.hook";
import {
  computeEffectiveChunkSize,
  E2E_CRYPTO_RECORD_SIZE,
} from "./uploadPerformance.util";

export { computeAdaptiveChunkSize } from "./uploadPerformance.util";

// --- Adaptive chunk sizing ---
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
// S3 uploads start in streaming mode; local storage asks the worker to fall
// back to buffered transport. The probe is deliberately tiny and bounded.
const PROBE_SMALL = 256_000;
const PROBE_LARGE = 8_000_000;
const PROBE_FAST_THRESHOLD = 10_000_000; // 10 MB/s -- trigger phase 2
const PROBE_CACHE_MS = 10 * 60 * 1000;
const PROBE_CACHE_KEY = "privcloud-upload-bandwidth-v1";

let bandwidthCache: { value: number; expiresAt: number } | null = null;

const WORKER_CACHE_KEY = Math.random().toString(36).slice(2);

/**
 * POST a zero-filled payload to /api/probe and return bytes/sec.
 * Returns 0 on error so the caller falls back to the config default.
 */
async function runProbe(size: number, timeoutMs: number): Promise<number> {
  const payload = new Uint8Array(size);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const resp = await fetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
      credentials: "include",
      signal: controller.signal,
    });
    if (!resp.ok) return 0;
    resp.body?.cancel();
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
  const elapsed = (performance.now() - start) / 1000;
  if (elapsed <= 0) return 0;
  return size / elapsed;
}

function getSlowConnectionEstimate(): number | null {
  try {
    const connection = (
      navigator as Navigator & {
        connection?: {
          downlink?: number;
          effectiveType?: string;
          saveData?: boolean;
        };
      }
    ).connection;
    if (!connection) return null;
    const isConstrained =
      connection.saveData ||
      ["slow-2g", "2g", "3g"].includes(connection.effectiveType || "");
    if (!isConstrained) return null;
    return connection.downlink && connection.downlink > 0
      ? connection.downlink * 125_000
      : 500_000;
  } catch {
    return null;
  }
}

function cacheBandwidth(value: number, now: number): number {
  bandwidthCache = { value, expiresAt: now + PROBE_CACHE_MS };
  try {
    sessionStorage.setItem(PROBE_CACHE_KEY, JSON.stringify(bandwidthCache));
  } catch {
    // In-memory cache still avoids repeated probes for this page lifetime.
  }
  return value;
}

/**
 * Measure upload bandwidth with a bounded two-phase probe. Results are
 * cached because the actual upload then refines concurrency passively.
 *
 * Returns bytes/sec. Falls back to 0 on error (caller uses config default).
 */
export async function measureBandwidth(): Promise<number> {
  const now = Date.now();
  if (bandwidthCache && bandwidthCache.expiresAt > now) {
    return bandwidthCache.value;
  }
  try {
    const stored = sessionStorage.getItem(PROBE_CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as {
        value?: number;
        expiresAt?: number;
      };
      if (
        typeof parsed.value === "number" &&
        typeof parsed.expiresAt === "number" &&
        parsed.expiresAt > now
      ) {
        bandwidthCache = {
          value: parsed.value,
          expiresAt: parsed.expiresAt,
        };
        return parsed.value;
      }
    }
  } catch {
    // sessionStorage can be unavailable in hardened/private contexts.
  }

  // On an already-known constrained link, the browser's coarse estimate is
  // enough for the conservative 5 MB S3 floor and avoids delaying startup.
  const constrainedEstimate = getSlowConnectionEstimate();
  if (constrainedEstimate !== null) {
    return cacheBandwidth(constrainedEstimate, now);
  }

  const bw1 = await runProbe(PROBE_SMALL, 1_200);
  if (bw1 <= 0) return 0;
  const measured =
    bw1 < PROBE_FAST_THRESHOLD
      ? bw1
      : (await runProbe(PROBE_LARGE, 2_500)) || bw1;
  return cacheBandwidth(measured, now);
}

/**
 * Measure bandwidth and return the effective chunk size.
 * Normal transfers are capped at 50 MB. Files large enough to exceed the S3
 * multipart part limit can use up to the authenticated backend cap (200 MB).
 * E2E transport chunks are encrypted as independent 1 MB records, avoiding
 * monolithic 50 MB WebCrypto allocations while keeping efficient S3 parts.
 * For slow connections the adaptive probe shrinks below the admin default.
 */
export async function getAdaptiveChunkSize(
  baseChunkSize: number,
  fileSize?: number,
  measuredBandwidthBps?: number,
): Promise<number> {
  const bandwidth =
    measuredBandwidthBps === undefined
      ? await measureBandwidth()
      : measuredBandwidthBps;
  return computeEffectiveChunkSize(baseChunkSize, bandwidth, fileSize);
}

// --- Single-Worker upload (no batch recycling) ---
// Worker.terminate() + immediate new Worker() caused SIGILL in Chrome's
// ThreadPoolForeground: V8 concurrent GC tasks for the old isolate were
// still queued on the ThreadPool when the new Worker started allocating,
// and they accessed a partially-destroyed V8 heap -> UD2 -> SIGILL.
// Fix: one Worker handles the full upload [0, totalChunks).
// Crypto is record-based, so WebCrypto allocations remain small even when
// the transport chunk sent to S3 is large.

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
  cryptoChunkSize: number,
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
          if (i > 0)
            await new Promise((r) => setTimeout(r, 5000 * Math.pow(2, i - 1)));
          result = await attempt();
        }
        // Release the slot ~100 ms after completion so rapid callers
        // reuse the result instead of firing a duplicate request.
        setTimeout(() => {
          refreshInFlight = null;
        }, 100);
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
      cryptoChunkSize,
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
    isE2E ? Math.min(E2E_CRYPTO_RECORD_SIZE, chunkSize) : chunkSize,
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
