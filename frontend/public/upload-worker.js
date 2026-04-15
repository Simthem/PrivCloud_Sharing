/**
 * upload-worker.js -- Web Worker for chunked file upload (batch mode)
 *
 * Uploads a BATCH of chunks [startChunk, endChunk) then reports
 * batch-complete. The main thread creates a FRESH Worker for each
 * batch and terminates it after completion. This forces full memory
 * cleanup (V8 isolate + Mojo pipe endpoints + network service objects)
 * between batches, preventing accumulation over thousands of chunks.
 *
 * Key optimisations vs the single-Worker approach:
 * - Blob body for E2E: Chrome reads Blobs incrementally (~64 KB at a
 *   time via BlobDataHandle) instead of serialising the full 25 MB
 *   ArrayBuffer through Mojo IPC.
 * - let scoping in the for-loop: each iteration's variables are
 *   block-scoped and GC-eligible immediately after the iteration.
 * - 5 ms yield between chunks: gives V8's scavenger a safe-point.
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
 */

var IV_LENGTH = 12;
var aborted = false;
var safelineResolved = false;
var safelineFailed = false;

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

  if (msg.type === "start") {
    aborted = false;
    safelineResolved = false;
    safelineFailed = false;
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
  var fileName = opts.fileName;
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

  var retryCount = 0;
  var MAX_RETRIES = 5;
  var refreshRetries403 = 0;
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
  // 250ms = max 4 req/s = 40 req/10s (safe margin).
  var MIN_CHUNK_INTERVAL_MS = 250;
  var lastSendTime = 0;

  for (let chunkIndex = startChunk; chunkIndex < endChunk; chunkIndex++) {
    if (aborted) {
      self.postMessage({ type: "error", message: "Upload aborted", status: 0, data: null });
      return;
    }

    let from = chunkIndex * chunkSize;
    let to = Math.min(from + chunkSize, file.size);

    // ---- Prepare chunk body ----
    let body;
    if (isE2E && cryptoKey) {
      let rawSlice = file.slice(from, to);
      let plainBuf = await rawSlice.arrayBuffer();
      rawSlice = null;

      let iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      let ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        plainBuf
      );
      plainBuf = null;

      // Blob body: Chrome reads via BlobDataHandle in ~64 KB increments
      // instead of serialising the full buffer through Mojo IPC.
      body = new Blob([iv, new Uint8Array(ciphertext)]);
      ciphertext = null;
      iv = null;
    } else {
      body = file.slice(from, to);
    }

    // ---- Build URL ----
    let url = "/api/shares/" + encodeURIComponent(shareId) + "/files?";
    url += "name=" + encodeURIComponent(fileName);
    url += "&chunkIndex=" + chunkIndex + "&totalChunks=" + totalChunks;
    url += "&chunkSize=" + chunkSize;
    if (fileId) url += "&id=" + encodeURIComponent(fileId);

    // ---- Send chunk (rate-limited) ----
    // Enforce minimum interval between chunk sends so we never exceed
    // SafeLine's 50 req/10s access rate limit.
    let now = Date.now();
    let elapsed = now - lastSendTime;
    if (elapsed < MIN_CHUNK_INTERVAL_MS) {
      await sleep(MIN_CHUNK_INTERVAL_MS - elapsed);
    }
    lastSendTime = Date.now();

    let controller = new AbortController();
    let timer = setTimeout(function () {
      controller.abort();
    }, 300000);

    try {
      let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: body,
        credentials: "include",
        signal: controller.signal,
      });
      clearTimeout(timer);
      body = null;

      if (!response.ok) {
        let httpStatus = response.status;
        let respData = null;
        try {
          respData = await response.json();
        } catch (_e) {
          // response.json() already locks the body stream; only cancel
          // if body is still readable (not locked by the json() attempt).
          try {
            if (response.body && !response.body.locked) response.body.cancel();
          } catch (_e2) {}
        }
        response = null;

        // 422 unexpected_chunk_index -> server tells us where to resume
        if (
          httpStatus === 422 &&
          respData &&
          respData.error === "unexpected_chunk_index"
        ) {
          chunkIndex = respData.expectedChunkIndex - 1;
          continue;
        }

        // 401 -> refresh access token and retry
        if (httpStatus === 401) {
          try {
            await fetch("/api/auth/token", {
              method: "POST",
              credentials: "include",
            });
            self.postMessage({ type: "token-refreshed" });
          } catch (_e2) {}
          chunkIndex--;
          continue;
        }

        // 468 -> SafeLine WAF challenge
        //
        // Strategy: try hidden iframe up to MAX_SAFELINE_IFRAME_ATTEMPTS
        // times.  On success the main thread sends 'safeline-resolved',
        // on failure it sends 'safeline-failed' -- we then wait with
        // escalating backoff before the next attempt to stay well under
        // SafeLine rate limits (50 req/10s, 10 err/20s).
        if (httpStatus === 468) {
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message: "Upload failed: WAF challenge could not be resolved after " + MAX_SAFELINE_468_RETRIES + " retries",
              status: 468,
              data: null,
            });
            return;
          }

          if (safelineChallengeAttempts < MAX_SAFELINE_IFRAME_ATTEMPTS) {
            safelineChallengeAttempts++;
            self.postMessage({ type: "need-safeline-challenge" });
            safelineResolved = false;
            safelineFailed = false;
            let waited = 0;
            while (!safelineResolved && !safelineFailed && waited < 120000) {
              await sleep(500);
              waited += 500;
            }
            if (safelineResolved) {
              // iframe succeeded -- retry chunk after a short pause
              safelineResolved = false;
              await sleep(2000);
              chunkIndex--;
              continue;
            }
            safelineFailed = false;
            // iframe failed or timed out -- fall through to backoff
          }

          // Show the user-facing notification once
          if (!safeline468Shown) {
            safeline468Shown = true;
            self.postMessage({ type: "safeline-failed-show-notification" });
          }

          // Escalating backoff: 10s, 15s, 20s, 30s, 45s, 60s, 60s...
          let safeBackoff = Math.min(
            SAFELINE_BACKOFF_BASE * Math.pow(1.5, safeline468Retries - 1),
            SAFELINE_BACKOFF_MAX
          );
          await sleep(safeBackoff);
          chunkIndex--;
          continue;
        }

        // 403 -> expired JWT or SafeLine session
        if (httpStatus === 403) {
          if (
            respData &&
            typeof respData.message === "string" &&
            respData.message.indexOf("quota") !== -1
          ) {
            self.postMessage({
              type: "quota-exceeded",
              message: respData.message || "Upload failed (quota limit)",
            });
            return;
          }

          if (refreshRetries403 < 3) {
            refreshRetries403++;
            try {
              await fetch("/api/auth/token", {
                method: "POST",
                credentials: "include",
              });
              chunkIndex--;
              continue;
            } catch (_e3) {}
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
              return;
            }
            if (safelineChallengeAttempts < MAX_SAFELINE_IFRAME_ATTEMPTS) {
              safelineChallengeAttempts++;
              self.postMessage({ type: "need-safeline-challenge" });
              safelineResolved = false;
              safelineFailed = false;
              let waited403 = 0;
              while (!safelineResolved && !safelineFailed && waited403 < 120000) {
                await sleep(500);
                waited403 += 500;
              }
              if (safelineResolved) {
                safelineResolved = false;
                await sleep(2000);
                chunkIndex--;
                continue;
              }
              safelineFailed = false;
            }
            if (!safeline468Shown) {
              safeline468Shown = true;
              self.postMessage({ type: "safeline-failed-show-notification" });
            }
            let safeBackoff403 = Math.min(
              SAFELINE_BACKOFF_BASE * Math.pow(1.5, safeline468Retries - 1),
              SAFELINE_BACKOFF_MAX
            );
            await sleep(safeBackoff403);
            chunkIndex--;
            continue;
          }

          self.postMessage({
            type: "error",
            message:
              (respData && respData.message) || "Upload failed (access denied)",
            status: 403,
            data: respData,
          });
          return;
        }

        // 413 -> payload too large (non-recoverable)
        if (httpStatus === 413) {
          self.postMessage({
            type: "error",
            message:
              (respData && respData.message) || "Upload failed (size limit)",
            status: 413,
            data: respData,
          });
          return;
        }

        // 500 with "session not found" -> the server cleaned up the
        // multipart upload (abandoned upload TTL).  Non-recoverable:
        // retrying will just hit the same error.
        if (
          httpStatus === 500 &&
          respData &&
          typeof respData.message === "string" &&
          respData.message.indexOf("session not found") !== -1
        ) {
          self.postMessage({
            type: "error",
            message:
              "Upload session expired on the server. The file must be re-uploaded from the start.",
            status: 500,
            data: respData,
          });
          return;
        }

        // Other errors -> retry with backoff
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          self.postMessage({
            type: "error",
            message: "Upload failed after " + MAX_RETRIES + " retries",
            status: httpStatus,
            data: respData,
          });
          return;
        }
        let delay = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);
        await sleep(delay);
        chunkIndex--;
        continue;
      }

      // ---- Success ----
      let jsonResult = await response.json();
      response = null;
      // Do NOT call controller.abort() -- request is complete, let
      // controller+signal go out of scope via block scoping (let).

      fileId = jsonResult.id;
      retryCount = 0;
      refreshRetries403 = 0;
      consecutiveOkChunks++;
      // After sustained success, progressively recover SafeLine state
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

      // Yield to give V8 a GC safe-point between chunks
      // (rate limiter at loop top handles pacing)
      await sleep(5);
    } catch (e) {
      clearTimeout(timer);
      body = null;
      consecutiveOkChunks = 0;

      if (aborted) {
        self.postMessage({ type: "error", message: "Upload aborted", status: 0, data: null });
        return;
      }

      retryCount++;
      if (retryCount >= MAX_RETRIES) {
        self.postMessage({
          type: "error",
          message: e.message || "Upload failed (network error)",
          status: 0,
          data: null,
        });
        return;
      }
      let retryDelay = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);
      await sleep(retryDelay);
      chunkIndex--;
      continue;
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
