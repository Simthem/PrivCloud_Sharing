import { showNotification } from "@mantine/notifications";
import { createElement } from "react";
import {
  completeSafeLineChallenge,
  refreshTokenOnce,
} from "../services/api.service";
import { notifySafeLineChallenge } from "./safeline-notify.util";
import { translateOutsideContext } from "../hooks/useTranslate.hook";
import {
  ADAPTIVE_MAX_CHUNK,
  computeEffectiveChunkSize,
  E2E_CRYPTO_RECORD_SIZE,
  getUploadChunkLayout,
  selectRepresentativeProbeBandwidth,
} from "./uploadPerformance.util";
import { notifyAuthSessionExpired } from "./authRedirect.util";
import { acquireUploadFlowCoordinator } from "./uploadBatchCoordinator.util";

export { computeAdaptiveChunkSize } from "./uploadPerformance.util";

// --- Adaptive chunk sizing ---
// 200 MB chunks caused 500 errors on large uploads when SafeLine WAF or
// Nginx had body-size / timeout limits below 200 MB, causing the proxy to
// drop the request before NestJS received it (non-JSON 500 body), triggering
// a ~30-minute stall in the upload worker's retry loop.
// The default 50 MB profile is shared by Free and paid clients:
//   - A 250 GB file uses 5,000 chunks (under the 9,500 cap)
//   - Continuously-filled S3 lanes cover fixed per-request latency
//   - 64-200 MB remains excluded from normal adaptive uploads because it
//     increases browser/WAF pressure and crosses common request-size limits.
// S3 uploads start in streaming mode; local storage asks the worker to fall
// back to buffered transport. The probe is deliberately tiny and bounded.
const PROBE_SMALL = 256_000;
const PROBE_LARGE = 8_000_000;
const PROBE_LARGE_TIMEOUT_MS = 6_000;
// Upload start may reuse a completed background probe, but it never waits
// several seconds for one. After this short grace period the known-good
// profile cap is used and the probe is cancelled so it cannot compete with
// the real transfer.
const PROBE_START_GRACE_MS = 150;
const PROBE_CACHE_MS = 10 * 60 * 1000;
// Bump the key whenever probe selection semantics change so a stale,
// WAF-latency-biased estimate cannot survive a frontend deployment.
const PROBE_CACHE_KEY = "privcloud-upload-bandwidth-v5";

let bandwidthCache: { value: number; expiresAt: number } | null = null;
let bandwidthProbeInFlight: Promise<number> | null = null;
let smallProbeInFlight: Promise<number> | null = null;
let smallProbeBandwidth = 0;
let activeLargeProbeController: AbortController | null = null;
let bandwidthProbeGeneration = 0;

const WORKER_CACHE_KEY = Math.random().toString(36).slice(2);
const multipartFileIds = new WeakMap<Blob, Map<string, string>>();
const PAGE_UPLOAD_COORDINATOR_KEY = "browser-direct-s3-page-pool";

function createMultipartFileId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function getStableMultipartFileId(file: File | Blob, shareId: string): string {
  let idsByShare = multipartFileIds.get(file);
  const existing = idsByShare?.get(shareId);
  if (existing) return existing;
  const created = createMultipartFileId();
  if (!idsByShare) {
    idsByShare = new Map();
    multipartFileIds.set(file, idsByShare);
  }
  idsByShare.set(shareId, created);
  return created;
}

function forgetStableMultipartFileId(file: File | Blob, shareId: string): void {
  const idsByShare = multipartFileIds.get(file);
  if (!idsByShare) return;
  idsByShare.delete(shareId);
  if (idsByShare.size === 0) multipartFileIds.delete(file);
}

/**
 * POST a zero-filled payload to /api/probe and return bytes/sec.
 * Returns 0 on error so the caller falls back to the config default.
 */
async function runProbe(
  size: number,
  timeoutMs: number,
  controller = new AbortController(),
): Promise<number> {
  const payload = new Uint8Array(size);
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

function readCachedBandwidth(now: number): number | null {
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
  return null;
}

function startSmallBandwidthProbe(): Promise<number> {
  const now = Date.now();
  const cached = readCachedBandwidth(now);
  if (cached !== null) return Promise.resolve(cached);

  const constrainedEstimate = getSlowConnectionEstimate();
  if (constrainedEstimate !== null) {
    return Promise.resolve(cacheBandwidth(constrainedEstimate, now));
  }
  if (smallProbeBandwidth > 0) return Promise.resolve(smallProbeBandwidth);
  if (smallProbeInFlight) return smallProbeInFlight;

  const probe = runProbe(PROBE_SMALL, 1_200).then((value) => {
    smallProbeBandwidth = value;
    return value;
  });
  smallProbeInFlight = probe;
  void probe.finally(() => {
    if (smallProbeInFlight === probe) smallProbeInFlight = null;
  });
  return probe;
}

/**
 * Measure upload bandwidth with a bounded two-phase probe. Results are
 * cached because the actual upload then refines concurrency passively.
 *
 * Returns bytes/sec. Falls back to 0 on error (caller uses the bounded
 * account profile).
 */
async function measureBandwidthOnce(generation: number): Promise<number> {
  const now = Date.now();
  const cached = readCachedBandwidth(now);
  if (cached !== null) return cached;

  // On an already-known constrained link, the browser's coarse estimate is
  // enough for the conservative 5 MB S3 floor and avoids delaying startup.
  const constrainedEstimate = getSlowConnectionEstimate();
  if (constrainedEstimate !== null) {
    return cacheBandwidth(constrainedEstimate, now);
  }

  const bw1 = await startSmallBandwidthProbe();
  if (generation !== bandwidthProbeGeneration) return 0;
  // The 256 KB phase is useful for reachability but cannot decide whether the
  // representative phase should run: fixed WAF latency, a cold proxy or one
  // transient challenge can make a fast connection look slower than 1 MB/s
  // or fail that request entirely. Outside a browser-reported constrained
  // connection, always attempt 8 MB and retain the best valid observation.
  const largeController = new AbortController();
  activeLargeProbeController = largeController;
  const bw2 = await runProbe(
    PROBE_LARGE,
    PROBE_LARGE_TIMEOUT_MS,
    largeController,
  );
  if (activeLargeProbeController === largeController) {
    activeLargeProbeController = null;
  }
  if (
    generation !== bandwidthProbeGeneration ||
    largeController.signal.aborted
  ) {
    return 0;
  }
  const measured = selectRepresentativeProbeBandwidth(bw1, bw2);
  if (measured <= 0) return 0;
  return cacheBandwidth(measured, now);
}

export async function measureBandwidth(): Promise<number> {
  if (bandwidthProbeInFlight) return bandwidthProbeInFlight;
  const generation = bandwidthProbeGeneration;
  const probe = measureBandwidthOnce(generation);
  bandwidthProbeInFlight = probe;
  try {
    return await probe;
  } finally {
    if (bandwidthProbeInFlight === probe) bandwidthProbeInFlight = null;
  }
}

/**
 * Warm the probe without putting any loading state on screen.
 *
 * The 256 KB phase is safe to start when the upload page opens. The 8 MB
 * representative phase starts after file selection and normally finishes
 * while the user fills in the share modal.
 */
export function prewarmUploadBandwidth(representative = false): void {
  if (representative) {
    void measureBandwidth();
  } else {
    void startSmallBandwidthProbe();
  }
}

function cancelBackgroundBandwidthProbe(): void {
  bandwidthProbeGeneration++;
  activeLargeProbeController?.abort();
  activeLargeProbeController = null;
  bandwidthProbeInFlight = null;
}

/**
 * Return a ready background measurement without delaying the real upload.
 * Zero means "use the configured profile cap".
 */
export async function measureBandwidthForUpload(): Promise<number> {
  const cached = readCachedBandwidth(Date.now());
  if (cached !== null) return cached;

  const probe = measureBandwidth();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_START_GRACE_MS);
  });
  const result = await Promise.race([probe, timeout]);
  if (timer) clearTimeout(timer);
  if (result === null) {
    cancelBackgroundBandwidthProbe();
    return 0;
  }
  return result;
}

/**
 * Measure bandwidth and return the effective chunk size.
 * The caller supplies the account profile cap. E2E transport chunks are
 * encrypted as independent 1 MB records,
 * avoiding monolithic WebCrypto allocations while keeping efficient S3 parts.
 * For slow connections the adaptive probe shrinks below the admin default.
 */
export async function getAdaptiveChunkSize(
  baseChunkSize: number,
  fileSize?: number,
  measuredBandwidthBps?: number,
  maxChunkSize = ADAPTIVE_MAX_CHUNK,
): Promise<number> {
  const bandwidth =
    measuredBandwidthBps === undefined
      ? await measureBandwidthForUpload()
      : measuredBandwidthBps;
  // A missing/aborted probe must not fall back to the legacy 10 MB database
  // default: that was the exact request-amplification regression observed
  // behind SafeLine. The account profile cap is already memory/WAF bounded.
  const sizingBaseChunkSize = bandwidth > 0 ? baseChunkSize : maxChunkSize;
  return computeEffectiveChunkSize(
    sizingBaseChunkSize,
    bandwidth,
    fileSize,
    maxChunkSize,
    maxChunkSize,
  );
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
  initialChunkSize: number,
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
    _uploadedBytes: number,
  ) => void,
  signal?: AbortSignal,
  maxParallelLanes?: number,
  plannedFileConcurrency?: number,
): Promise<{ fileId: string; nextChunk: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/upload-worker.js?v=" + WORKER_CACHE_KEY);
    let cleanedUp = false;
    const flowCoordinator = acquireUploadFlowCoordinator(
      PAGE_UPLOAD_COORDINATOR_KEY,
      (maxParallel) => {
        if (!cleanedUp) {
          worker.postMessage({
            type: "direct-window-update",
            maxParallel,
          });
        }
      },
    );

    // ---- Shared token refresh logic ----
    // Both the proactive keepalive and the worker's need-token-refresh
    // handler delegate to the app-wide single-flight refresher in
    // api.service, so the upload can never race the axios interceptor or
    // auth.service on the refresh_token rotation (which would 401 the loser
    // and log the user out mid-/post-upload).
    const doTokenRefresh = (): Promise<boolean> =>
      refreshTokenOnce().then((r) => r.ok);

    // Proactive token refresh: fires every 10 min to rotate the
    // access_token before its 13-min cookie maxAge expires browser-side.
    // This prevents "chunk gets 401 -> worker requests refresh -> refresh
    // itself gets 401 because the token was never refreshed" scenarios on
    // long uploads (large .vmdk, .iso, etc.).
    const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min
    const proactiveRefreshTimer = setInterval(() => {
      doTokenRefresh().catch(() => {});
    }, TOKEN_REFRESH_INTERVAL_MS);

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(proactiveRefreshTimer);
      signal?.removeEventListener("abort", onAbort);
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      flowCoordinator.close();
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
          onProgress(
            msg.chunkIndex,
            msg.totalChunks,
            msg.fileId,
            msg.uploadedBytes,
          );
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

        case "size-limit-exceeded":
          cleanup();
          {
            const err: any = new Error(msg.message);
            err.status = 403;
            err.sizeLimit = true;
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
            const result = await refreshTokenOnce();
            if (!result.ok && result.status === 401) {
              notifyAuthSessionExpired();
            }
            worker.postMessage({
              type: result.ok ? "token-refresh-done" : "token-refresh-failed",
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

        case "direct-pool-config":
          flowCoordinator.configure({
            originCount: msg.originCount,
            connectionsPerOrigin: msg.connectionsPerOrigin,
            maxConcurrency: msg.maxConcurrency,
            relayFallbackConcurrency: msg.relayFallbackConcurrency,
            relayGlobalConcurrency: msg.relayGlobalConcurrency,
          });
          break;

        case "acquire-direct-slot":
          void flowCoordinator
            .acquireDirect(
              Array.isArray(msg.candidates)
                ? msg.candidates.map((candidate: any) => ({
                    origin: String(candidate?.origin || ""),
                  }))
                : [],
            )
            .then((grant) => {
              if (!cleanedUp) {
                worker.postMessage({
                  type: "direct-slot-granted",
                  requestId: msg.requestId,
                  ...grant,
                });
              } else {
                flowCoordinator.releaseDirect(grant.leaseId, "cancelled");
              }
            })
            .catch((error) => {
              if (!cleanedUp) {
                worker.postMessage({
                  type: "direct-slot-denied",
                  requestId: msg.requestId,
                  message: error?.message || "Direct upload slot unavailable",
                });
              }
            });
          break;

        case "release-direct-slot":
          flowCoordinator.releaseDirect(
            msg.leaseId,
            msg.outcome,
            msg.retryAfterMs,
          );
          break;

        case "acquire-relay-slot":
          void flowCoordinator
            .acquireRelay()
            .then((leaseId) => {
              if (!cleanedUp) {
                worker.postMessage({
                  type: "relay-slot-granted",
                  requestId: msg.requestId,
                  leaseId,
                });
              } else {
                flowCoordinator.releaseRelay(leaseId);
              }
            })
            .catch((error) => {
              if (!cleanedUp) {
                worker.postMessage({
                  type: "relay-slot-denied",
                  requestId: msg.requestId,
                  message: error?.message || "Relay slot unavailable",
                });
              }
            });
          break;

        case "release-relay-slot":
          flowCoordinator.releaseRelay(msg.leaseId);
          break;

        case "retrying": {
          const t = translateOutsideContext();
          const delaySec = Math.round(msg.delayMs / 1000);
          console.warn(
            `[upload] retry -> chunk=${msg.chunkIndex} status=${
              msg.httpStatus ?? 0
            } attempt=${msg.attempt}/${msg.maxAttempts} delayMs=${msg.delayMs}`,
          );
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
      initialChunkSize,
      totalChunks,
      isE2E,
      cryptoKeyRaw,
      cryptoChunkSize,
      startChunk,
      endChunk,
      fileId,
      fileName,
      relativePath,
      maxParallelLanes,
      plannedFileConcurrency,
      // Current backends continuously advertise the fair data window. The
      // Worker keeps only a hardware/memory safety ceiling and falls back to
      // legacy chunk-0 negotiation during rolling upgrades.
      serverManagedWindow: true,
    });
  });
}

/**
 * Upload a complete file through one persistent Worker.
 * The Worker owns the bounded lane/body pipeline and is terminated after the
 * file completes, fails or is cancelled.
 */
export async function uploadFileViaWorker(
  file: File | Blob,
  shareId: string,
  chunkSize: number,
  isE2E: boolean,
  cryptoKey: CryptoKey | null,
  onProgress: (
    _chunkIndex: number,
    _totalChunks: number,
    _fileId: string,
    _uploadedBytes: number,
  ) => void,
  signal?: AbortSignal,
  relativePath?: string,
  maxParallelLanes?: number,
  plannedFileConcurrency?: number,
): Promise<string> {
  let cryptoKeyRaw: ArrayBuffer | null = null;
  if (isE2E) {
    if (!cryptoKey) {
      throw new Error("E2E encryption key is required for encrypted uploads");
    }
    cryptoKeyRaw = await crypto.subtle.exportKey("raw", cryptoKey);
  }

  // Keep the UUID stable across the page-level retry queue. The backend can
  // then reconcile already committed S3 parts instead of creating an orphaned
  // multipart upload and retransmitting the complete file.
  let fileId: string | undefined = getStableMultipartFileId(file, shareId);
  // Do not trust caller arithmetic here: the Worker uses a variable-size
  // bootstrap part, so its total and bounds must come from one authoritative
  // layout calculation.
  const { initialChunkSize, totalChunks } = getUploadChunkLayout(
    file.size,
    chunkSize,
  );

  // Single Worker for the entire upload: no mid-transfer recycling.
  let result: { fileId: string; nextChunk: number };
  try {
    result = await runWorkerBatch(
      file,
      shareId,
      chunkSize,
      initialChunkSize,
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
      maxParallelLanes,
      plannedFileConcurrency,
    );
  } catch (error: any) {
    if (error?.cancelled) forgetStableMultipartFileId(file, shareId);
    throw error;
  }

  fileId = result.fileId;
  forgetStableMultipartFileId(file, shareId);
  return fileId!;
}
