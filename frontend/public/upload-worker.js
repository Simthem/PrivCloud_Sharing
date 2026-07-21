/**
 * upload-worker.js -- Web Worker for chunked file upload (parallel mode)
 *
 * A SINGLE Worker instance handles the entire upload [0, totalChunks).
 * Chunk 0 is sent sequentially to initialize the S3 multipart session.
 * Chunk 0 negotiates the storage transport. S3-backed chunks 1..N are
 * streamed through the backend with an adaptive sliding window; local
 * storage stays sequential because it appends chunks in order.
 *
 * Backend safety net: a global semaphore in s3.service.ts caps total
 * in-flight UploadPart calls across all users (default 4, tunable with
 * S3_MAX_CONCURRENT_UPLOADS).
 * If all slots are busy, the backend returns 429 and the Worker retries
 * with exponential backoff.
 *
 * Memory safety without recycling:
 * - Large transport chunks contain independent 1 MB AES-GCM records.
 * - The lane count is still bounded according to device memory.
 * - No controller.abort() on success: avoids stale AbortEvent dispatch.
 *
 * Protocol (main <-> worker):
 *   main -> worker: { type: 'start', shareId, file, chunkSize,
 *                     totalChunks, isE2E, cryptoKeyRaw?, fileId?,
 *                     fileName, startChunk, endChunk }
 *   main -> worker: { type: 'safeline-resolved' }
 *   main -> worker: { type: 'abort' }
 *
 *   worker -> main: { type: 'progress', chunkIndex, totalChunks, fileId }
 *   worker -> main: { type: 'batch-complete', fileId, nextChunk }
 *   worker -> main: { type: 'error', message, status, data }
 *   worker -> main: { type: 'need-safeline-challenge' }
 *   worker -> main: { type: 'safeline-failed-show-notification' }
 *   worker -> main: { type: 'token-refreshed' }
 *   worker -> main: { type: 'quota-exceeded', message }
 *   worker -> main: { type: 'retrying', chunkIndex, attempt, maxAttempts, delayMs, httpStatus }
 *   worker -> main: { type: 'recovery', chunkIndex, attempt, maxAttempts, pauseMs }
 */

var IV_LENGTH = 12;
var aborted = false;
var safelineResolved = false;
var safelineFailed = false;
// Token refresh flags -- main thread handles the actual fetch because
// Safari does NOT send HttpOnly cookies in fetch() from Web Workers
// (long-standing WebKit bug).  The Worker posts 'need-token-refresh' and
// waits; the main thread replies 'token-refresh-done' or 'token-refresh-failed'.
var tokenRefreshDone = false;
var tokenRefreshFailed = false;

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "abort") {
    aborted = true;
    return;
  }

  if (msg.type === "safeline-resolved") {
    safelineResolved = true;
    return;
  }

  if (msg.type === "safeline-failed") {
    safelineFailed = true;
    return;
  }

  if (msg.type === "token-refresh-done") {
    tokenRefreshDone = true;
    return;
  }

  if (msg.type === "token-refresh-failed") {
    tokenRefreshFailed = true;
    return;
  }

  if (msg.type === "start") {
    aborted = false;
    safelineResolved = false;
    safelineFailed = false;
    tokenRefreshDone = false;
    tokenRefreshFailed = false;
    runBatch(msg);
  }
};

// ---- Batch upload loop ----
async function runBatch(opts) {
  var shareId = opts.shareId;
  var file = opts.file;
  var chunkSize = opts.chunkSize;
  var totalChunks = opts.totalChunks;
  var isE2E = opts.isE2E;
  var cryptoChunkSize = opts.cryptoChunkSize || chunkSize;
  var fileName = opts.fileName;
  var relativePath = opts.relativePath;
  var startChunk = opts.startChunk || 0;
  var endChunk = opts.endChunk != null ? opts.endChunk : totalChunks;
  var fileId = opts.fileId || undefined;

  // Import crypto key once per batch
  var cryptoKey = null;
  if (isE2E && opts.cryptoKeyRaw) {
    try {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        opts.cryptoKeyRaw,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        message: "Crypto key import failed: " + (err.message || err),
        status: 0,
        data: null,
      });
      return;
    }
  }

  var MAX_RETRIES = 5;          // permanent HTTP errors (4xx, non-recoverable 5xx)
  var MAX_RETRIES_TRANSIENT = 20; // transient errors (502, 503, network)
  var MAX_RECOVERY_CYCLES = 3;    // after MAX_RETRIES_TRANSIENT, cool-down + reset
  var RECOVERY_PAUSE_MS = 60000; // 1 min pause between recovery cycles (was 2 min)
  var MAX_SESSION_MISSING_RETRIES = 12; // wrong blue/green backend during drain
  var safelineChallengeAttempts = 0;
  var MAX_SAFELINE_IFRAME_ATTEMPTS = 3;
  var safeline468Shown = false;
  var safeline468Retries = 0;
  var MAX_SAFELINE_468_RETRIES = 60;
  var consecutiveOkChunks = 0;
  // Escalating backoff for SafeLine WAF retries to stay well under
  // rate limits (50 req/10s basic, 10 req/20s error).
  // Sequence: 30s, 45s, 60s, 90s, 120s, 120s, ...
  var SAFELINE_BACKOFF_BASE = 30000;
  var SAFELINE_BACKOFF_MAX = 120000;
  // Rate limiting: minimum interval between successive chunk sends,
  // so we never exceed SafeLine's 50 req/10s access limit.
  // With adaptive chunk sizing (up to 50 MB), large chunks naturally
  // reduce request frequency.  For chunks >= 50 MB the transfer time
  // alone is several seconds, so no guard is needed (0 ms).
  // For smaller chunks, 50 ms = max 20 req/s which is safe.
  var MIN_CHUNK_INTERVAL_MS = opts.chunkSize >= 50000000 ? 0 : 50;
  var lastSendTime = 0;

  // A transport chunk stays large for network/S3 efficiency, while E2E data
  // is encoded as smaller independently authenticated AES-GCM records. This
  // lets a slow recipient decrypt after a few MB without multiplying HTTP
  // requests or S3 multipart parts.
  async function prepareChunkBody(idx) {
    var from = idx * chunkSize;
    var to = Math.min(from + chunkSize, file.size);
    if (isE2E && cryptoKey) {
      var plainLength = to - from;
      var recordCount = Math.ceil(plainLength / cryptoChunkSize);
      var combined = new Uint8Array(plainLength + recordCount * 28);

      // Two records per batch hide Blob/WebCrypto call latency while keeping
      // peak memory close to the sequential path. Output offsets are stable,
      // so parallel encryption cannot reorder records.
      var cryptoParallel = hardwareConcurrency >= 4 ? 2 : 1;
      for (var recordIndex = 0; recordIndex < recordCount; recordIndex += cryptoParallel) {
        var tasks = [];
        var batchEnd = Math.min(recordIndex + cryptoParallel, recordCount);
        for (var current = recordIndex; current < batchEnd; current++) {
          tasks.push((async function (currentRecord) {
            var recordOffset = currentRecord * cryptoChunkSize;
            var recordEnd = Math.min(recordOffset + cryptoChunkSize, plainLength);
            var plainBuf = await file
              .slice(from + recordOffset, from + recordEnd)
              .arrayBuffer();
            var iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
            var ciphertext = await crypto.subtle.encrypt(
              { name: "AES-GCM", iv: iv },
              cryptoKey,
              plainBuf
            );
            var outputOffset = recordOffset + currentRecord * 28;
            combined.set(iv, outputOffset);
            combined.set(new Uint8Array(ciphertext), outputOffset + IV_LENGTH);
          })(current));
        }
        await Promise.all(tasks);
      }
      return combined;
    } else {
      return file.slice(from, to);
    }
  }
  // ---- Adaptive chunk dispatch ----
  // Chunk 0 negotiates the transport with the backend. A legacy backend
  // keeps the buffered two-lane behavior. S3 streaming can safely use more
  // lanes, while local append-only storage explicitly returns one lane.
  var uploadTransport = "stream";
  var MAX_PARALLEL = 2;
  var deviceMemoryGb = self.navigator && self.navigator.deviceMemory
    ? self.navigator.deviceMemory
    : 0;
  var hardwareConcurrency = self.navigator && self.navigator.hardwareConcurrency
    ? self.navigator.hardwareConcurrency
    : 2;
  var browserParallelCap = isE2E
    ? (deviceMemoryGb >= 8 || (!deviceMemoryGb && hardwareConcurrency >= 8)
      ? 3
      : (deviceMemoryGb >= 4 || hardwareConcurrency >= 4 ? 3 : 2))
    : 4;
  // Files around 1 TB require ~100 MB S3 transport chunks to stay below the
  // multipart part-count ceiling. Keep the aggregate encrypted buffers bounded
  // on the client while two large lanes are still enough to fill a 1 Gbps link.
  if (isE2E && chunkSize >= 100000000) {
    browserParallelCap = Math.min(
      browserParallelCap,
      deviceMemoryGb > 0 && deviceMemoryGb < 8 ? 1 : 2,
    );
  }
  var serverParallelCap = 2;

  // ---- Token refresh dedup ----
  // Only one refresh runs at a time; parallel chunks reuse the result.
  var refreshPromise = null;
  async function ensureTokenRefreshed() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async function () {
      tokenRefreshDone = false;
      tokenRefreshFailed = false;
      self.postMessage({ type: "need-token-refresh" });
      var waited = 0;
      while (!tokenRefreshDone && !tokenRefreshFailed && waited < 30000) {
        await sleep(500);
        waited += 500;
      }
      var ok = tokenRefreshDone;
      if (ok) self.postMessage({ type: "token-refreshed" });
      // Keep result for 2 s so rapid duplicate 401s skip the refresh
      setTimeout(function () { refreshPromise = null; }, 2000);
      return ok;
    })();
    return refreshPromise;
  }

  // ---- SafeLine challenge dedup ----
  // Only one challenge flow runs at a time.
  var safelinePromise = null;
  async function handleSafelineOnce() {
    if (safelinePromise) return safelinePromise;
    safelinePromise = (async function () {
      if (safelineChallengeAttempts < MAX_SAFELINE_IFRAME_ATTEMPTS) {
        safelineChallengeAttempts++;
        self.postMessage({ type: "need-safeline-challenge" });
        safelineResolved = false;
        safelineFailed = false;
        var waited = 0;
        while (!safelineResolved && !safelineFailed && waited < 120000) {
          await sleep(500);
          waited += 500;
        }
        if (safelineResolved) {
          safelineResolved = false;
          await sleep(2000);
          setTimeout(function () { safelinePromise = null; }, 1000);
          return true;
        }
        safelineFailed = false;
      }
      if (!safeline468Shown) {
        safeline468Shown = true;
        self.postMessage({ type: "safeline-failed-show-notification" });
      }
      var safeBackoff = Math.min(
        SAFELINE_BACKOFF_BASE * Math.pow(1.5, safeline468Retries - 1),
        SAFELINE_BACKOFF_MAX
      );
      safelineResolved = false;
      var waitedBack = 0;
      while (waitedBack < safeBackoff && !safelineResolved) {
        await sleep(500);
        waitedBack += 500;
      }
      var resolved = safelineResolved;
      if (resolved) {
        safelineResolved = false;
        safeline468Retries = 0;
        safelineChallengeAttempts = 0;
        safeline468Shown = false;
        await sleep(1000);
      }
      setTimeout(function () { safelinePromise = null; }, 1000);
      return resolved;
    })();
    return safelinePromise;
  }

  // ---- Send a single chunk with full retry/auth/SafeLine handling ----
  // Returns { ok: true } on success, { ok: false } on fatal error
  // (error message already posted to main thread).
  async function sendSingleChunk(chunkIndex) {
    var localRetries = 0;       // permanent error counter
    var transientRetries = 0;   // transient error counter (502/503/network)
    var recoveryCycles = 0;     // how many 2-min recovery pauses we've done
    var sessionMissingRetries = 0;
    var localRefresh403 = 0;

    while (true) {
      if (aborted) {
        self.postMessage({ type: "error", message: "Upload aborted", status: 0, data: null });
        return { ok: false };
      }

      var body = await prepareChunkBody(chunkIndex);

      // ---- Build URL ----
      var url = "/api/shares/" + encodeURIComponent(shareId) + "/files?";
      url += "chunkIndex=" + chunkIndex + "&totalChunks=" + totalChunks;
      url += "&chunkSize=" + chunkSize;
      if (isE2E) url += "&encryptionChunkSize=" + cryptoChunkSize;
      if (fileId) url += "&id=" + encodeURIComponent(fileId);

      // Rate-limit guard
      var now = Date.now();
      var elapsed = now - lastSendTime;
      if (elapsed < MIN_CHUNK_INTERVAL_MS) {
        await sleep(MIN_CHUNK_INTERVAL_MS - elapsed);
      }
      lastSendTime = Date.now();

      var controller = new AbortController();
      var timer = setTimeout(function () {
        console.error("[WRK-TIMEOUT] chunk", chunkIndex, "aborted after 300s");
        controller.abort();
      }, 300000);

      try {
        var headers = {
          "Content-Type": uploadTransport === "stream"
            ? "application/vnd.privcloud.chunk"
            : "application/octet-stream",
          "X-File-Name": encodeURIComponent(fileName),
        };
        if (relativePath) {
          headers["X-File-Relative-Path"] = encodeURIComponent(relativePath);
        }

        var bodyBytes = typeof body.size === "number" ? body.size : body.byteLength;
        var transferStartedAt = performance.now();
        var response = await fetch(url, {
          method: "POST",
          headers: headers,
          body: body,
          credentials: "include",
          signal: controller.signal,
        });
        body = null;
        clearTimeout(timer);

        if (!response.ok) {
          var httpStatus = response.status;
          var respData = null;
          try {
            respData = await response.json();
          } catch (_e) {
            try {
              if (response.body && !response.body.locked) response.body.cancel();
            } catch (_e2) {}
          }
          response = null;

          // A legacy backend or an upstream WAF may reject the negotiated
          // media type. Retry the same chunk on the buffered compatibility
          // path so blue/green rollouts do not interrupt active uploads.
          var contentLengthRejected = httpStatus === 400 && respData &&
            typeof respData.message === "string" &&
            respData.message.indexOf("Content-Length") !== -1;
          if (uploadTransport === "stream" &&
            (httpStatus === 415 || contentLengthRejected)) {
            uploadTransport = "buffered";
            MAX_PARALLEL = Math.min(MAX_PARALLEL, 2);
            continue;
          }

          // 429 -> server busy (S3 upload slots full), retry with backoff
          if (httpStatus === 429) {
            // Back off the shared window immediately. Repeatedly resubmitting
            // the same number of lanes only prolongs backend contention.
            MAX_PARALLEL = Math.max(1, MAX_PARALLEL - 1);
            localRetries++;
            if (localRetries >= MAX_RETRIES) {
              self.postMessage({ type: "error", message: "Server busy after " + MAX_RETRIES + " retries", status: 429, data: null });
              return { ok: false };
            }
            await sleep(Math.min(3000 * Math.pow(2, localRetries - 1), 30000));
            continue;
          }

          // 422 unexpected_chunk_index -> retry same chunk
          if (httpStatus === 422 && respData && respData.error === "unexpected_chunk_index") {
            continue;
          }

          // 401 -> access token expired
          if (httpStatus === 401) {
            var refreshOk = await ensureTokenRefreshed();
            if (!refreshOk) {
              self.postMessage({
                type: "error",
                message: "Session expired. Please log in again and retry the upload.",
                status: 401,
                data: null,
              });
              return { ok: false };
            }
            continue;
          }

          // 468 -> SafeLine WAF challenge
          if (httpStatus === 468) {
            safeline468Retries++;
            if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
              self.postMessage({
                type: "error",
                message: "Upload failed: WAF challenge could not be resolved after " + MAX_SAFELINE_468_RETRIES + " retries",
                status: 468,
                data: null,
              });
              return { ok: false };
            }
            await handleSafelineOnce();
            continue;
          }

          // 403 -> expired JWT or SafeLine session
          if (httpStatus === 403) {
            if (respData && typeof respData.message === "string" && respData.message.indexOf("quota") !== -1) {
              self.postMessage({ type: "quota-exceeded", message: respData.message || "Upload failed (quota limit)" });
              return { ok: false };
            }
            if (localRefresh403 < 3) {
              localRefresh403++;
              var refreshOk403 = await ensureTokenRefreshed();
              if (!refreshOk403) {
                self.postMessage({
                  type: "error",
                  message: "Session expired. Please log in again and retry the upload.",
                  status: 403,
                  data: null,
                });
                return { ok: false };
              }
              continue;
            }
            if (!respData || !respData.error) {
              safeline468Retries++;
              if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
                self.postMessage({
                  type: "error",
                  message: "Upload failed: WAF challenge could not be resolved after " + MAX_SAFELINE_468_RETRIES + " retries",
                  status: 403,
                  data: null,
                });
                return { ok: false };
              }
              await handleSafelineOnce();
              continue;
            }
            self.postMessage({
              type: "error",
              message: (respData && respData.message) || "Upload failed (access denied)",
              status: 403,
              data: respData,
            });
            return { ok: false };
          }

          // 413 -> payload too large (non-recoverable)
          if (httpStatus === 413) {
            self.postMessage({
              type: "error",
              message: (respData && respData.message) || "Upload failed (size limit)",
              status: 413,
              data: respData,
            });
            return { ok: false };
          }

          // 500 with "session not found" can happen if HAProxy sends a later
          // chunk to the other blue/green container while the S3 multipart
          // upload session is still in memory on the original one. Give ops a
          // short recovery window to put the original color back in DRAIN.
          if (httpStatus === 500 && respData && typeof respData.message === "string" &&
            respData.message.indexOf("session not found") !== -1) {
            sessionMissingRetries++;
            if (sessionMissingRetries <= MAX_SESSION_MISSING_RETRIES) {
              var sessionDelay = Math.min(5000 * Math.pow(2, sessionMissingRetries - 1), 30000);
              var sessionJitter = Math.floor(Math.random() * 2000);
              self.postMessage({
                type: "retrying",
                chunkIndex: chunkIndex,
                attempt: sessionMissingRetries,
                maxAttempts: MAX_SESSION_MISSING_RETRIES,
                delayMs: sessionDelay + sessionJitter,
                httpStatus: 500,
              });
              await sleep(sessionDelay + sessionJitter);
              continue;
            }
            self.postMessage({
              type: "error",
              message: "Upload session expired on the server. The file must be re-uploaded from the start.",
              status: 500,
              data: respData,
            });
            return { ok: false };
          }

          // CompleteMultipartUpload failed: upload state is uncertain, restart
          // required to avoid committing duplicate or corrupted parts.
          if (httpStatus === 500 && respData && typeof respData.message === "string" &&
            respData.message.indexOf("completion failed") !== -1) {
            self.postMessage({
              type: "error",
              message: "Upload session expired on the server. The file must be re-uploaded from the start.",
              status: 500,
              data: respData,
            });
            return { ok: false };
          }

          // 503 -> backend temporarily unavailable (S3 transient from our NestJS, session still alive
          //        on S3 side).  Short backoff (30s max) so the upload resumes quickly once S3
          //        recovers.  If Nginx/Caddy itself is overloaded it usually returns 502 not 503.
          if (httpStatus === 503) {
            transientRetries++;
            if (transientRetries >= MAX_RETRIES_TRANSIENT) {
              if (recoveryCycles < MAX_RECOVERY_CYCLES) {
                recoveryCycles++;
                self.postMessage({
                  type: "recovery",
                  chunkIndex: chunkIndex,
                  attempt: recoveryCycles,
                  maxAttempts: MAX_RECOVERY_CYCLES,
                  pauseMs: RECOVERY_PAUSE_MS,
                });
                await sleep(RECOVERY_PAUSE_MS);
                transientRetries = 0;
                continue;
              }
              self.postMessage({
                type: "error",
                message: "Server unavailable after " + (MAX_RETRIES_TRANSIENT * (MAX_RECOVERY_CYCLES + 1)) + " retries (HTTP 503)",
                status: 503,
                data: respData,
              });
              return { ok: false };
            }
            // Short backoff: 5s, 10s, 20s, 30s, 30s... capped at 30s
            // The S3 multipart session is still alive -- once S3 recovers the retry succeeds.
            var s503Delay = Math.min(5000 * Math.pow(2, transientRetries - 1), 30000);
            var s503Jitter = Math.floor(Math.random() * 2000);
            self.postMessage({
              type: "retrying",
              chunkIndex: chunkIndex,
              attempt: transientRetries,
              maxAttempts: MAX_RETRIES_TRANSIENT,
              delayMs: s503Delay + s503Jitter,
              httpStatus: 503,
            });
            await sleep(s503Delay + s503Jitter);
            continue;
          }

          // 502 -> proxy/CDN failure (upstream returned invalid response or timed out).
          //        Longer backoff: the load balancer or Nginx may take longer to recover.
          if (httpStatus === 502) {
            transientRetries++;
            if (transientRetries >= MAX_RETRIES_TRANSIENT) {
              if (recoveryCycles < MAX_RECOVERY_CYCLES) {
                recoveryCycles++;
                self.postMessage({
                  type: "recovery",
                  chunkIndex: chunkIndex,
                  attempt: recoveryCycles,
                  maxAttempts: MAX_RECOVERY_CYCLES,
                  pauseMs: RECOVERY_PAUSE_MS,
                });
                await sleep(RECOVERY_PAUSE_MS);
                transientRetries = 0;
                continue;
              }
              self.postMessage({
                type: "error",
                message: "Server unavailable after " + (MAX_RETRIES_TRANSIENT * (MAX_RECOVERY_CYCLES + 1)) + " retries (HTTP 502)",
                status: 502,
                data: respData,
              });
              return { ok: false };
            }
            // Backoff with jitter: 5s, 10s, 20s, 40s, 60s... capped at 120s
            var baseDelay = Math.min(5000 * Math.pow(2, transientRetries - 1), 120000);
            var jitter = Math.floor(Math.random() * 3000);
            self.postMessage({
              type: "retrying",
              chunkIndex: chunkIndex,
              attempt: transientRetries,
              maxAttempts: MAX_RETRIES_TRANSIENT,
              delayMs: baseDelay + jitter,
              httpStatus: 502,
            });
            await sleep(baseDelay + jitter);
            continue;
          }

          // Other errors -> retry with backoff
          // Use transient counter for 5xx (server-side), permanent for 4xx
          if (httpStatus >= 500) {
            transientRetries++;
            if (transientRetries >= MAX_RETRIES_TRANSIENT) {
              if (recoveryCycles < MAX_RECOVERY_CYCLES) {
                recoveryCycles++;
                self.postMessage({
                  type: "recovery",
                  chunkIndex: chunkIndex,
                  attempt: recoveryCycles,
                  maxAttempts: MAX_RECOVERY_CYCLES,
                  pauseMs: RECOVERY_PAUSE_MS,
                });
                await sleep(RECOVERY_PAUSE_MS);
                transientRetries = 0;
                continue;
              }
              self.postMessage({
                type: "error",
                message: "Upload failed after " + (MAX_RETRIES_TRANSIENT * (MAX_RECOVERY_CYCLES + 1)) + " retries",
                status: httpStatus,
                data: respData,
              });
              return { ok: false };
            }
            var otherDelay = Math.min(5000 * Math.pow(2, transientRetries - 1), 60000);
            var otherJitter = Math.floor(Math.random() * 2000);
            self.postMessage({
              type: "retrying",
              chunkIndex: chunkIndex,
              attempt: transientRetries,
              maxAttempts: MAX_RETRIES_TRANSIENT,
              delayMs: otherDelay + otherJitter,
              httpStatus: httpStatus,
            });
            await sleep(otherDelay + otherJitter);
            continue;
          }
          localRetries++;
          if (localRetries >= MAX_RETRIES) {
            self.postMessage({
              type: "error",
              message: "Upload failed after " + MAX_RETRIES + " retries",
              status: httpStatus,
              data: respData,
            });
            return { ok: false };
          }
          await sleep(Math.min(1000 * Math.pow(2, localRetries - 1), 16000));
          continue;
        }

        // ---- Success ----
        var jsonResult = await response.json();
        var transferSeconds = Math.max(
          (performance.now() - transferStartedAt) / 1000,
          0.001
        );
        var observedBps = bodyBytes / transferSeconds;
        response = null;

        // The first chunk provides the initial estimate. Real chunks then
        // refine it passively: increase one lane at a time only when the
        // observed aggregate rate can use it. Slow links stay at one lane.
        var aggregateBps = observedBps * MAX_PARALLEL;
        if (chunkIndex > startChunk &&
          uploadTransport === "stream" &&
          MAX_PARALLEL < serverParallelCap &&
          aggregateBps >= 30_000_000) {
          MAX_PARALLEL++;
        }

        fileId = jsonResult.id;
        localRetries = 0;
        transientRetries = 0;
        recoveryCycles = 0;
        sessionMissingRetries = 0;
        localRefresh403 = 0;
        consecutiveOkChunks++;
        if (consecutiveOkChunks >= 10) {
          safelineChallengeAttempts = 0;
          safeline468Shown = false;
        }
        if (consecutiveOkChunks >= 30) {
          safeline468Retries = 0;
        }

        self.postMessage({
          type: "progress",
          chunkIndex: chunkIndex,
          totalChunks: totalChunks,
          fileId: fileId,
        });
        return {
          ok: true,
          uploadTransport: jsonResult.uploadTransport,
          uploadConcurrency: jsonResult.uploadConcurrency,
          observedBps: observedBps,
        };
      } catch (e) {
        clearTimeout(timer);
        body = null;
        consecutiveOkChunks = 0;
        if (aborted) {
          self.postMessage({ type: "error", message: "Upload aborted", status: 0, data: null });
          return { ok: false };
        }
        transientRetries++;
        if (transientRetries >= MAX_RETRIES_TRANSIENT) {
          if (recoveryCycles < MAX_RECOVERY_CYCLES) {
            recoveryCycles++;
            self.postMessage({
              type: "recovery",
              chunkIndex: chunkIndex,
              attempt: recoveryCycles,
              maxAttempts: MAX_RECOVERY_CYCLES,
              pauseMs: RECOVERY_PAUSE_MS,
            });
            await sleep(RECOVERY_PAUSE_MS);
            transientRetries = 0;
            continue;
          }
          self.postMessage({
            type: "error",
            message: e.message || "Upload failed (network error)",
            status: 0,
            data: null,
          });
          return { ok: false };
        }
        var netBaseDelay = Math.min(5000 * Math.pow(2, transientRetries - 1), 120000);
        var netJitter = Math.floor(Math.random() * 3000);
        self.postMessage({
          type: "retrying",
          chunkIndex: chunkIndex,
          attempt: transientRetries,
          maxAttempts: MAX_RETRIES_TRANSIENT,
          delayMs: netBaseDelay + netJitter,
          httpStatus: 0,
        });
        await sleep(netBaseDelay + netJitter);
        // retry
      }
    }
  }

  // ---- Phase 1: chunk 0 sequential (initializes S3 multipart session) ----
  var result0 = await sendSingleChunk(startChunk);
  if (!result0.ok) return;

  if (result0.uploadTransport === "stream") {
    uploadTransport = "stream";
  }
  var serverParallel = Number(result0.uploadConcurrency);
  if (Number.isFinite(serverParallel) && serverParallel >= 1) {
    serverParallelCap = Math.min(Math.floor(serverParallel), browserParallelCap);
    var firstBps = Number(result0.observedBps) || 0;
    MAX_PARALLEL = firstBps >= 30_000_000
      ? serverParallelCap
      : firstBps >= 10_000_000
        ? Math.min(3, serverParallelCap)
        : firstBps >= 2_000_000
          ? Math.min(2, serverParallelCap)
          : 1;
  }

  // ---- Phase 2: remaining chunks with sliding window ----
  var nextIdx = startChunk + 1;
  var activeChunks = new Map(); // idx -> Promise<{idx, ok}>

  function launchChunk(idx) {
    var p = sendSingleChunk(idx).then(function (r) {
      return { idx: idx, ok: r.ok };
    });
    activeChunks.set(idx, p);
  }

  // Fill initial window
  while (activeChunks.size < MAX_PARALLEL && nextIdx < endChunk) {
    launchChunk(nextIdx++);
  }

  while (activeChunks.size > 0) {
    var completed = await Promise.race(activeChunks.values());
    activeChunks.delete(completed.idx);

    if (!completed.ok) {
      // Fatal error -- sendSingleChunk already posted the error message.
      return;
    }

    // Fill window
    while (activeChunks.size < MAX_PARALLEL && nextIdx < endChunk) {
      launchChunk(nextIdx++);
    }
  }

  // Batch complete -- main thread will terminate this Worker
  self.postMessage({
    type: "batch-complete",
    fileId: fileId,
    nextChunk: endChunk,
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}
