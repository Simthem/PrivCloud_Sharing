/**
 * upload-worker.js -- Web Worker for chunked file upload (parallel mode)
 *
 * A SINGLE Worker instance handles the entire upload [0, totalChunks).
 * A lightweight control request initializes the S3 multipart session before
 * any large body is sent. All data parts can then enter a server-managed,
 * adaptive sliding window immediately. Legacy backends retain the sequential
 * chunk-0 negotiation path; local storage remains append-only and sequential.
 *
 * Backend authority: an adaptive fair scheduler caps and advertises the
 * available in-flight UploadPart calls. The Worker reapplies that allocation
 * after every response; local hardware memory/CPU is the only client ceiling.
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
 *                     initialChunkSize,
 *                     totalChunks, isE2E, cryptoKeyRaw?, fileId?,
 *                     fileName, startChunk, endChunk }
 *   main -> worker: { type: 'safeline-resolved' }
 *   main -> worker: { type: 'abort' }
 *
 *   worker -> main: { type: 'progress', chunkIndex, totalChunks, fileId,
 *                     uploadedBytes }
 *   worker -> main: { type: 'batch-complete', fileId, nextChunk }
 *   worker -> main: { type: 'error', message, status, data }
 *   worker -> main: { type: 'need-safeline-challenge' }
 *   worker -> main: { type: 'safeline-failed-show-notification' }
 *   worker -> main: { type: 'token-refreshed' }
 *   worker -> main: { type: 'size-limit-exceeded', message }
 *   worker -> main: { type: 'retrying', chunkIndex, attempt, maxAttempts, delayMs, httpStatus }
 *   worker -> main: { type: 'recovery', chunkIndex, attempt, maxAttempts, pauseMs }
 */

var UPLOAD_CLIENT_REVISION = "multipath-origin-pool-v9";
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
var coordinatorRequestSequence = 0;
var directSlotWaiters = new Map();
var relaySlotWaiters = new Map();
var coordinatorWindowUpdate = 0;

function rejectCoordinatorWaiters(message) {
  var error = new Error(message || "Upload coordination cancelled");
  directSlotWaiters.forEach(function (waiter) {
    waiter.reject(error);
  });
  relaySlotWaiters.forEach(function (waiter) {
    waiter.reject(error);
  });
  directSlotWaiters.clear();
  relaySlotWaiters.clear();
}

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "abort") {
    aborted = true;
    rejectCoordinatorWaiters("Upload aborted");
    return;
  }

  if (msg.type === "direct-window-update") {
    var updatedWindow = Number(msg.maxParallel);
    if (Number.isFinite(updatedWindow) && updatedWindow >= 1) {
      coordinatorWindowUpdate = Math.max(1, Math.floor(updatedWindow));
    }
    return;
  }

  if (
    msg.type === "direct-slot-granted" ||
    msg.type === "direct-slot-denied"
  ) {
    var directWaiter = directSlotWaiters.get(msg.requestId);
    if (directWaiter) {
      directSlotWaiters.delete(msg.requestId);
      if (msg.type === "direct-slot-granted") directWaiter.resolve(msg);
      else directWaiter.reject(new Error(msg.message || "Direct slot denied"));
    }
    return;
  }

  if (msg.type === "relay-slot-granted" || msg.type === "relay-slot-denied") {
    var relayWaiter = relaySlotWaiters.get(msg.requestId);
    if (relayWaiter) {
      relaySlotWaiters.delete(msg.requestId);
      if (msg.type === "relay-slot-granted") relayWaiter.resolve(msg);
      else relayWaiter.reject(new Error(msg.message || "Relay slot denied"));
    }
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
    rejectCoordinatorWaiters("Starting a new upload");
    coordinatorWindowUpdate = 0;
    runBatch(msg).catch(function (error) {
      self.postMessage({
        type: "error",
        message: "Upload worker failed: " + (error.message || error),
        status: 0,
        data: null,
      });
    });
  }
};

// ---- Batch upload loop ----
async function runBatch(opts) {
  var shareId = opts.shareId;
  var file = opts.file;
  var chunkSize = opts.chunkSize;
  var initialChunkSize = chunkSize;
  if (opts.initialChunkSize != null) {
    if (
      typeof opts.initialChunkSize !== "number" ||
      !Number.isSafeInteger(opts.initialChunkSize) ||
      opts.initialChunkSize <= 0 ||
      opts.initialChunkSize > chunkSize
    ) {
      throw new Error("Invalid initial upload chunk size");
    }
    initialChunkSize = opts.initialChunkSize;
  }
  var totalChunks = opts.totalChunks;
  var isE2E = opts.isE2E;
  var cryptoChunkSize = opts.cryptoChunkSize || chunkSize;
  var fileName = opts.fileName;
  var relativePath = opts.relativePath;
  var startChunk = opts.startChunk || 0;
  var endChunk = opts.endChunk != null ? opts.endChunk : totalChunks;
  var fileId = opts.fileId || undefined;
  var serverManagedWindow = opts.serverManagedWindow === true;
  var plannedFileConcurrency = Math.max(
    1,
    Math.min(
      8,
      Number.isFinite(opts.plannedFileConcurrency)
        ? Math.floor(opts.plannedFileConcurrency)
        : 1,
    ),
  );
  var expectedTotalChunks =
    file.size > chunkSize
      ? 1 + Math.ceil((file.size - initialChunkSize) / chunkSize)
      : 1;
  if (file.size <= chunkSize && initialChunkSize !== chunkSize) {
    throw new Error("Single-part upload cannot use a bootstrap chunk");
  }
  if (
    !Number.isSafeInteger(totalChunks) ||
    totalChunks !== expectedTotalChunks
  ) {
    throw new Error("Invalid totalChunks for upload chunk layout");
  }
  if (
    isE2E &&
    file.size > initialChunkSize &&
    initialChunkSize % cryptoChunkSize !== 0
  ) {
    throw new Error("Initial E2E chunk must end on a crypto record boundary");
  }

  function getChunkBounds(idx) {
    var from = idx === 0 ? 0 : initialChunkSize + (idx - 1) * chunkSize;
    return {
      from: from,
      to: Math.min(
        from + (idx === 0 ? initialChunkSize : chunkSize),
        file.size,
      ),
    };
  }

  function getExpectedBodyBytes(idx) {
    var bounds = getChunkBounds(idx);
    var plainBytes = Math.max(0, bounds.to - bounds.from);
    if (!isE2E) return plainBytes;
    return plainBytes + Math.ceil(plainBytes / cryptoChunkSize) * 28;
  }

  function getUrlOrigin(value) {
    if (typeof value !== "string") return "";
    var match = /^(https?):\/\/([^/?#]+)/i.exec(value.trim());
    if (!match) return "";
    return match[1].toLowerCase() + "://" + match[2].toLowerCase();
  }

  function normalizeDirectCandidates(authorization) {
    var candidates = [];
    var raw =
      authorization && Array.isArray(authorization.candidates)
        ? authorization.candidates
        : [];
    if (authorization && typeof authorization.url === "string") {
      raw = raw.concat([
        {
          url: authorization.url,
          origin: getUrlOrigin(authorization.url),
          addressingMode: "legacy",
        },
      ]);
    }
    var seen = new Set();
    raw.forEach(function (candidate) {
      var url = candidate && candidate.url;
      var derivedOrigin = getUrlOrigin(url);
      if (!derivedOrigin) return;
      var advertisedOrigin =
        candidate && typeof candidate.origin === "string"
          ? candidate.origin.trim().toLowerCase()
          : derivedOrigin;
      // A forged/malformed origin hint must never let the page coordinator
      // account a request against a different host from the signed URL.
      if (advertisedOrigin !== derivedOrigin || seen.has(url)) return;
      seen.add(url);
      candidates.push({
        url: url,
        origin: derivedOrigin,
        addressingMode:
          (candidate && (candidate.addressingMode || candidate.addressing)) ||
          "unknown",
      });
    });
    return candidates;
  }

  function acquireDirectSlot(candidates) {
    coordinatorRequestSequence++;
    var requestId =
      "direct-" + Date.now().toString(36) + "-" + coordinatorRequestSequence;
    return new Promise(function (resolve, reject) {
      directSlotWaiters.set(requestId, { resolve: resolve, reject: reject });
      self.postMessage({
        type: "acquire-direct-slot",
        requestId: requestId,
        candidates: candidates.map(function (candidate) {
          return { origin: candidate.origin };
        }),
      });
    });
  }

  function releaseDirectSlot(leaseId, outcome, retryAfterMs) {
    if (!leaseId) return;
    self.postMessage({
      type: "release-direct-slot",
      leaseId: leaseId,
      outcome: outcome || "success",
      retryAfterMs: retryAfterMs || 0,
    });
  }

  function acquireRelaySlot() {
    coordinatorRequestSequence++;
    var requestId =
      "relay-" + Date.now().toString(36) + "-" + coordinatorRequestSequence;
    return new Promise(function (resolve, reject) {
      relaySlotWaiters.set(requestId, { resolve: resolve, reject: reject });
      self.postMessage({
        type: "acquire-relay-slot",
        requestId: requestId,
      });
    });
  }

  function releaseRelaySlot(leaseId) {
    if (!leaseId) return;
    self.postMessage({
      type: "release-relay-slot",
      leaseId: leaseId,
    });
  }

  function parseRetryAfterMs(response) {
    try {
      if (!response || !response.headers || !response.headers.get) return 0;
      var value = response.headers.get("Retry-After");
      if (!value) return 0;
      var seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(120_000, seconds * 1000);
      }
      var timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) {
        return Math.min(120_000, Math.max(0, timestamp - Date.now()));
      }
    } catch {}
    return 0;
  }

  // Encryption is a security property of the share, not a best-effort
  // optimization. Never let an E2E upload fall through to the plaintext path.
  if (isE2E && !opts.cryptoKeyRaw) {
    self.postMessage({
      type: "error",
      message: "E2E encryption key is required for encrypted uploads",
      status: 0,
      data: null,
    });
    return;
  }

  // Import crypto key once per batch
  var cryptoKey = null;
  if (isE2E) {
    try {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        opts.cryptoKeyRaw,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
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

  var MAX_RETRIES = 5; // permanent HTTP errors (4xx, non-recoverable 5xx)
  var MAX_RETRIES_TRANSIENT = 20; // transient errors (502, 503, network)
  var MAX_RECOVERY_CYCLES = 3; // after MAX_RETRIES_TRANSIENT, cool-down + reset
  var RECOVERY_PAUSE_MS = 60000; // 1 min pause between recovery cycles (was 2 min)
  var MAX_SESSION_MISSING_RETRIES = 12; // stale backend during a rolling restart
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
  var deviceMemoryGb =
    self.navigator && self.navigator.deviceMemory
      ? self.navigator.deviceMemory
      : 0;
  var hardwareConcurrency =
    self.navigator && self.navigator.hardwareConcurrency
      ? self.navigator.hardwareConcurrency
      : 2;

  // WebCrypto has its own native worker pool. Letting every transport body
  // submit four records independently made a six-lane upload fan out to
  // 24-28 simultaneous Blob reads/encryptions, causing GC/I/O waves before
  // fetch() could start. Keep one cap for the complete Worker instead.
  var cryptoParallel =
    hardwareConcurrency >= 8 ? 4 : hardwareConcurrency >= 4 ? 2 : 1;
  var activeCryptoTasks = 0;
  var cryptoWaiters = [];

  async function acquireCryptoSlot() {
    if (activeCryptoTasks >= cryptoParallel) {
      await new Promise(function (resolve) {
        cryptoWaiters.push(resolve);
      });
      return;
    }
    activeCryptoTasks++;
  }

  function releaseCryptoSlot() {
    var next = cryptoWaiters.shift();
    if (next) {
      // Transfer the occupied slot directly to the oldest waiter. Keeping the
      // counter unchanged avoids a microtask race temporarily opening slot N+1.
      next();
    } else {
      activeCryptoTasks--;
    }
  }

  async function encryptRecord(iv, plaintext) {
    await acquireCryptoSlot();
    try {
      return await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        plaintext,
      );
    } finally {
      releaseCryptoSlot();
    }
  }

  var prepareTimings = new Map(); // idx -> { prepareMs, readMs, cryptoMs }

  // A transport chunk stays large for network/S3 efficiency, while E2E data
  // is encoded as smaller independently authenticated AES-GCM records. This
  // lets a slow recipient decrypt after a few MB without multiplying HTTP
  // requests or S3 multipart parts.
  async function prepareChunkBody(idx) {
    var prepareStartedAt = performance.now();
    var readMs = 0;
    var cryptoMs = 0;
    var chunkBounds = getChunkBounds(idx);
    var from = chunkBounds.from;
    var to = chunkBounds.to;
    if (isE2E) {
      var plainLength = to - from;
      var recordCount = Math.ceil(plainLength / cryptoChunkSize);
      var combined = new Uint8Array(plainLength + recordCount * 28);

      // Read one contiguous batch instead of issuing one Blob read per record.
      // AES-GCM still runs once per record with a fresh IV, and output offsets
      // remain byte-for-byte compatible: [12-byte IV][ciphertext+16-byte tag].
      for (
        var recordIndex = 0;
        recordIndex < recordCount;
        recordIndex += cryptoParallel
      ) {
        var batchEnd = Math.min(recordIndex + cryptoParallel, recordCount);
        var batchPlainOffset = recordIndex * cryptoChunkSize;
        var batchPlainEnd = Math.min(batchEnd * cryptoChunkSize, plainLength);
        var readStartedAt = performance.now();
        var batchPlainBuffer = await file
          .slice(from + batchPlainOffset, from + batchPlainEnd)
          .arrayBuffer();
        readMs += performance.now() - readStartedAt;
        var batchPlain = new Uint8Array(batchPlainBuffer);
        var tasks = [];
        for (var current = recordIndex; current < batchEnd; current++) {
          tasks.push(
            (async function (currentRecord) {
              var recordOffset = currentRecord * cryptoChunkSize;
              var recordEnd = Math.min(
                recordOffset + cryptoChunkSize,
                plainLength,
              );
              var localRecordOffset = recordOffset - batchPlainOffset;
              var plainView = batchPlain.subarray(
                localRecordOffset,
                localRecordOffset + recordEnd - recordOffset,
              );
              var iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
              var ciphertext = await encryptRecord(iv, plainView);
              var outputOffset = recordOffset + currentRecord * 28;
              combined.set(iv, outputOffset);
              combined.set(
                new Uint8Array(ciphertext),
                outputOffset + IV_LENGTH,
              );
            })(current),
          );
        }
        var cryptoStartedAt = performance.now();
        await Promise.all(tasks);
        cryptoMs += performance.now() - cryptoStartedAt;
        batchPlain = null;
        batchPlainBuffer = null;
      }
      prepareTimings.set(idx, {
        prepareMs: performance.now() - prepareStartedAt,
        readMs: readMs,
        cryptoMs: cryptoMs,
      });
      return combined;
    } else {
      var plainBody = file.slice(from, to);
      prepareTimings.set(idx, {
        prepareMs: performance.now() - prepareStartedAt,
        readMs: 0,
        cryptoMs: 0,
      });
      return plainBody;
    }
  }
  // ---- Prepared-body cache and bounded E2E preparation ----
  // Completing a small number of bodies at a time is deliberate. Starting six
  // 50 MB preparations together makes the global crypto FIFO advance every
  // body in lock-step, so all network lanes remain empty and then start as one
  // large GC/I/O wave. Two body producers still overlap Blob I/O with the four
  // WebCrypto tasks, but make the first usable ciphertext body available much
  // earlier. Retries reuse the exact same authenticated bytes.
  var bodyPrepareParallel = isE2E ? (hardwareConcurrency >= 4 ? 2 : 1) : 6;
  var activeBodyPreparations = 0;
  var bodyPreparationQueue = [];

  function drainBodyPreparationQueue() {
    while (
      activeBodyPreparations < bodyPrepareParallel &&
      bodyPreparationQueue.length > 0
    ) {
      var job = bodyPreparationQueue.shift();
      activeBodyPreparations++;
      Promise.resolve()
        .then(function () {
          return prepareChunkBody(job.idx);
        })
        .then(job.resolve, job.reject)
        .finally(function () {
          activeBodyPreparations--;
          drainBodyPreparationQueue();
        });
    }
  }

  function scheduleChunkBodyPreparation(idx) {
    return new Promise(function (resolve, reject) {
      bodyPreparationQueue.push({ idx: idx, resolve: resolve, reject: reject });
      drainBodyPreparationQueue();
    });
  }

  var preparedBodies = new Map(); // idx -> Promise<body>
  function getPreparedBody(idx) {
    var cached = preparedBodies.get(idx);
    if (cached) return cached;
    var prepared = scheduleChunkBodyPreparation(idx);
    preparedBodies.set(idx, prepared);
    return prepared;
  }
  function releasePreparedBody(idx) {
    preparedBodies.delete(idx);
    prepareTimings.delete(idx);
  }

  // ---- Adaptive chunk dispatch ----
  // Current backends own the performance window. The browser only applies a
  // hardware safety ceiling derived from its reported memory/CPU. Legacy
  // deployments retain the former six-lane compatibility calculation.
  // Start on the universally supported buffered media type. The worker only
  // switches to the streaming media type after either the control-plane init
  // or the legacy first-part response explicitly advertises it. This keeps a
  // mixed-version rollout and a WAF that has not learned the new init route
  // from making the very first file impossible to upload.
  var uploadTransport = "buffered";
  var directUploadUnavailable = false;
  var browserOriginPoolMode = false;
  var directOriginCount = 1;
  var directConnectionsPerOrigin = 6;
  var directMaxConcurrency = 6;
  var uploadRelayFallbackConcurrency = 1;
  var uploadRelayGlobalConcurrency = 1;
  var MAX_PARALLEL = 2;
  var PREFETCH_AHEAD = isE2E ? 1 : 0;
  var capableDevice =
    hardwareConcurrency >= 8 && (deviceMemoryGb >= 8 || deviceMemoryGb === 0);
  var balancedDevice =
    hardwareConcurrency >= 4 && (deviceMemoryGb >= 4 || deviceMemoryGb === 0);
  var legacyBrowserParallelCap = capableDevice
    ? 6
    : balancedDevice
      ? isE2E
        ? 3
        : 4
      : 2;
  if (
    typeof opts.maxParallelLanes === "number" &&
    Number.isFinite(opts.maxParallelLanes)
  ) {
    legacyBrowserParallelCap = Math.min(
      legacyBrowserParallelCap,
      Math.max(1, Math.min(6, Math.floor(opts.maxParallelLanes))),
    );
  }
  var memoryBudgetBytes =
    deviceMemoryGb > 0
      ? deviceMemoryGb * 1024 * 1024 * 1024 * 0.15
      : 512 * 1024 * 1024;
  var bytesPerLane = Math.max(
    chunkSize + (isE2E ? Math.ceil(chunkSize / cryptoChunkSize) * 28 : 0),
    1,
  );
  var memoryLaneCap = Math.max(1, Math.floor(memoryBudgetBytes / bytesPerLane));
  var cpuLaneCap = Math.max(2, hardwareConcurrency * 2);
  // This is a fail-safe protocol ceiling, not a performance profile. Normal
  // allocations are substantially lower and come from the server.
  var CLIENT_PROTOCOL_SAFETY_MAX = 32;
  var hardwareParallelCap = Math.max(
    1,
    Math.min(CLIENT_PROTOCOL_SAFETY_MAX, memoryLaneCap, cpuLaneCap),
  );
  var browserParallelCap = serverManagedWindow
    ? hardwareParallelCap
    : legacyBrowserParallelCap;
  var serverParallelCap = 2;
  var serverGlobalCap = 0;
  var serverActiveFlows = 0;
  var serverFairShare = 0;
  var uploadedPlainBytes = 0;
  var completedProgressChunks = new Set();
  var initialWindowPrewarmed = false;
  var plannedFlowPopulationReached = plannedFileConcurrency <= 1;

  function applyDirectPoolConfig(result) {
    if (!result || result.uploadWindowMode !== "browser-origin-pool") {
      return false;
    }
    var direct = result.directUpload || {};
    directOriginCount = Math.max(
      1,
      Math.min(8, Math.floor(Number(direct.originCount) || 1)),
    );
    directConnectionsPerOrigin = Math.max(
      1,
      Math.min(8, Math.floor(Number(direct.connectionsPerOrigin) || 6)),
    );
    var physicalMaximum = directOriginCount * directConnectionsPerOrigin;
    directMaxConcurrency = Math.max(
      1,
      Math.min(
        32,
        physicalMaximum,
        Math.floor(
          Number(direct.maxConcurrency) ||
            Number(result.uploadGlobalConcurrency) ||
            physicalMaximum,
        ),
      ),
    );
    uploadRelayFallbackConcurrency = Math.max(
      1,
      Math.min(
        2,
        Math.floor(Number(result.uploadRelayFallbackConcurrency) || 1),
      ),
    );
    uploadRelayGlobalConcurrency = Math.max(
      1,
      Math.min(
        CLIENT_PROTOCOL_SAFETY_MAX,
        Math.floor(
          Number(result.uploadRelayGlobalConcurrency) ||
            uploadRelayFallbackConcurrency,
        ),
      ),
    );
    browserOriginPoolMode = true;
    PREFETCH_AHEAD = 0;
    serverGlobalCap = directMaxConcurrency;
    serverParallelCap = Math.max(
      1,
      Math.min(
        directMaxConcurrency,
        browserParallelCap,
        coordinatorWindowUpdate || directMaxConcurrency,
      ),
    );
    MAX_PARALLEL = serverParallelCap;
    self.postMessage({
      type: "direct-pool-config",
      originCount: directOriginCount,
      connectionsPerOrigin: directConnectionsPerOrigin,
      maxConcurrency: directMaxConcurrency,
      relayFallbackConcurrency: uploadRelayFallbackConcurrency,
      relayGlobalConcurrency: uploadRelayGlobalConcurrency,
    });
    return true;
  }

  function isParallelUploadTransport() {
    return uploadTransport === "stream" || uploadTransport === "direct-s3";
  }

  function prewarmInitialWindow() {
    if (!isE2E || initialWindowPrewarmed || serverManagedWindow) return;
    initialWindowPrewarmed = true;

    // Queue one future lane window while chunk 0 is in flight. The preparation
    // cap above completes the earliest bodies first instead of allocating and
    // partially encrypting every body at once.
    var warmEnd = Math.min(endChunk, startChunk + 1 + browserParallelCap);
    for (var warmIdx = startChunk + 1; warmIdx < warmEnd; warmIdx++) {
      getPreparedBody(warmIdx);
    }
  }

  function applyServerWindow(result) {
    if (applyDirectPoolConfig(result)) return true;
    var advertised = Number(result && result.uploadConcurrency);
    if (!Number.isFinite(advertised) || advertised < 1) return false;
    var previousGlobalCap = serverGlobalCap;
    var previousActiveFlows = serverActiveFlows;
    var previousFairShare = serverFairShare;
    var previousLanes = MAX_PARALLEL;
    serverGlobalCap = Number(result.uploadGlobalConcurrency) || 0;
    serverActiveFlows = Number(result.uploadActiveFlows) || 0;
    serverFairShare = Number(result.uploadFairShare) || 0;
    if (serverActiveFlows >= plannedFileConcurrency) {
      plannedFlowPopulationReached = true;
    }
    var effectiveAdvertised = Math.floor(advertised);
    if (!plannedFlowPopulationReached && serverGlobalCap > 0) {
      effectiveAdvertised = Math.min(
        effectiveAdvertised,
        Math.max(1, Math.floor(serverGlobalCap / plannedFileConcurrency)),
      );
    }
    serverParallelCap = Math.max(
      1,
      Math.min(effectiveAdvertised, browserParallelCap),
    );
    MAX_PARALLEL = isParallelUploadTransport()
      ? serverParallelCap
      : Math.min(2, serverParallelCap);
    if (
      previousGlobalCap > 0 &&
      (serverGlobalCap !== previousGlobalCap ||
        serverActiveFlows !== previousActiveFlows ||
        serverFairShare !== previousFairShare ||
        MAX_PARALLEL !== previousLanes)
    ) {
      console.info(
        "[upload] window -> globalConcurrency=" +
          serverGlobalCap +
          " activeFlows=" +
          serverActiveFlows +
          " fairShare=" +
          serverFairShare +
          " lanes=" +
          MAX_PARALLEL,
      );
    }
    return true;
  }

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
      setTimeout(function () {
        refreshPromise = null;
      }, 2000);
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
          setTimeout(function () {
            safelinePromise = null;
          }, 1000);
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
        SAFELINE_BACKOFF_MAX,
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
      setTimeout(function () {
        safelinePromise = null;
      }, 1000);
      return resolved;
    })();
    return safelinePromise;
  }

  function getMultipartControlPayloadObject() {
    return {
      id: fileId,
      name: fileName,
      relativePath: relativePath,
      totalChunks: totalChunks,
      fileSize: file.size,
      chunkSize: chunkSize,
      initialChunkSize: initialChunkSize,
      encryptionChunkSize: isE2E ? cryptoChunkSize : undefined,
    };
  }

  function getMultipartControlPayload() {
    return JSON.stringify(getMultipartControlPayloadObject());
  }

  async function initializeMultipartSession() {
    if (
      !serverManagedWindow ||
      startChunk !== 0 ||
      totalChunks < 2 ||
      !crypto ||
      typeof crypto.randomUUID !== "function"
    ) {
      return { ready: false, fatal: false };
    }
    fileId = fileId || crypto.randomUUID();
    var initUrl =
      "/api/shares/" + encodeURIComponent(shareId) + "/files/multipart/init";
    var payload = getMultipartControlPayload();
    var initRefresh403 = 0;
    var maxInitAttempts = 8;

    for (var attempt = 1; attempt <= maxInitAttempts; attempt++) {
      if (aborted) return { ready: false, fatal: true };
      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort();
      }, 15_000);
      try {
        var response = await fetch(initUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          credentials: "include",
          signal: controller.signal,
        });
        clearTimeout(timer);
        var data = null;
        try {
          data = await response.json();
        } catch {
          try {
            response.body && response.body.cancel();
          } catch {}
        }

        if (response.ok) {
          if (
            data &&
            (data.uploadTransport === "stream" ||
              data.uploadTransport === "direct-s3") &&
            (data.uploadWindowMode === "server-adaptive-fair" ||
              data.uploadWindowMode === "browser-origin-pool")
          ) {
            fileId = data.id || fileId;
            uploadTransport = data.uploadTransport;
            applyServerWindow(data);
            return { ready: true, fatal: false, data: data };
          }
          // Local storage, or a backend that understands the route but does
          // not expose the adaptive protocol, uses the legacy data path.
          return { ready: false, fatal: false };
        }

        if ([404, 405, 415, 501].indexOf(response.status) !== -1) {
          console.warn(
            "[upload] multipart init unavailable -> status=" +
              response.status +
              " fallback=buffered-first-part",
          );
          return { ready: false, fatal: false };
        }
        if (response.status === 401) {
          if (await ensureTokenRefreshed()) continue;
          self.postMessage({
            type: "error",
            message:
              "Session expired. Please log in again and retry the upload.",
            status: 401,
            data: data,
          });
          return { ready: false, fatal: true };
        }
        if (response.status === 468) {
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message:
                "Upload initialization failed: WAF challenge could not be resolved",
              status: 468,
              data: data,
            });
            return { ready: false, fatal: true };
          }
          await handleSafelineOnce();
          continue;
        }
        if (response.status === 413) {
          self.postMessage({
            type: "size-limit-exceeded",
            message: (data && data.message) || "Upload failed (size limit)",
          });
          return { ready: false, fatal: true };
        }
        if (response.status === 403) {
          // A structured NestJS 403 is an application authorization decision
          // and must never be bypassed. SafeLine commonly answers with an
          // HTML/empty 403 instead: refresh the session once, then use the
          // same challenge-and-resume path as data chunks.
          if (data && data.error) {
            self.postMessage({
              type: "error",
              message: data.message || "Upload initialization was denied",
              status: 403,
              data: data,
            });
            return { ready: false, fatal: true };
          }
          if (initRefresh403 < 1) {
            initRefresh403++;
            if (await ensureTokenRefreshed()) continue;
          }
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message:
                "Upload initialization failed: WAF challenge could not be resolved",
              status: 403,
              data: data,
            });
            return { ready: false, fatal: true };
          }
          await handleSafelineOnce();
          continue;
        }
        if (response.status >= 500 || response.status === 429) {
          console.warn(
            "[upload] multipart init transient failure -> status=" +
              response.status +
              " attempt=" +
              attempt +
              "/" +
              maxInitAttempts,
          );
          if (attempt < maxInitAttempts) {
            var initRetryAfter = parseRetryAfterMs(response);
            await sleep(
              Math.max(
                initRetryAfter,
                Math.min(500 * Math.pow(2, attempt - 1), 15_000) +
                  Math.floor(Math.random() * 500),
              ),
            );
          }
          continue;
        }
        self.postMessage({
          type: "error",
          message: (data && data.message) || "Multipart initialization failed",
          status: response.status,
          data: data,
        });
        return { ready: false, fatal: true };
      } catch (error) {
        clearTimeout(timer);
        if (aborted) return { ready: false, fatal: true };
        console.warn(
          "[upload] multipart init network failure -> attempt=" +
            attempt +
            "/" +
            maxInitAttempts +
            " error=" +
            (error && error.name ? error.name : "NetworkError"),
        );
        if (attempt < maxInitAttempts) {
          await sleep(Math.min(250 * Math.pow(2, attempt - 1), 1_000));
          continue;
        }
        self.postMessage({
          type: "error",
          message:
            "Multipart initialization is temporarily unavailable; the upload can be retried with the same session.",
          status: 503,
          data: null,
        });
        return { ready: false, fatal: true };
      }
    }
    self.postMessage({
      type: "error",
      message:
        "Multipart initialization did not recover after " +
        maxInitAttempts +
        " attempts",
      status: 503,
      data: null,
    });
    return { ready: false, fatal: true };
  }

  /**
   * Complete from S3's authoritative part list after every data request has
   * succeeded. This is safe to repeat and lets an upload cross a rolling
   * upgrade even when no single Nest process observed every ETag.
   */
  async function finalizeMultipartSession() {
    var completeUrl =
      "/api/shares/" +
      encodeURIComponent(shareId) +
      "/files/multipart/complete";
    var maxCompleteAttempts = 12;
    var completeRefresh403 = 0;

    for (var attempt = 1; attempt <= maxCompleteAttempts; attempt++) {
      if (aborted) return false;
      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort();
      }, 180_000);
      try {
        var response = await fetch(completeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: getMultipartControlPayload(),
          credentials: "include",
          signal: controller.signal,
        });
        clearTimeout(timer);
        var data = null;
        try {
          data = await response.json();
        } catch {
          try {
            response.body && response.body.cancel();
          } catch {}
        }

        if (response.ok) {
          fileId = (data && data.id) || fileId;
          return true;
        }
        if (response.status === 401) {
          if (await ensureTokenRefreshed()) continue;
          self.postMessage({
            type: "error",
            message:
              "Session expired. Please log in again and retry the upload.",
            status: 401,
            data: data,
          });
          return false;
        }
        if (response.status === 413) {
          self.postMessage({
            type: "size-limit-exceeded",
            message: (data && data.message) || "Upload failed (size limit)",
          });
          return false;
        }
        if (response.status === 468) {
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message:
                "Upload finalization failed: WAF challenge could not be resolved",
              status: 468,
              data: data,
            });
            return false;
          }
          await handleSafelineOnce();
          continue;
        }
        if (response.status === 403) {
          if (data && data.error) {
            self.postMessage({
              type: "error",
              message: data.message || "Upload finalization was denied",
              status: 403,
              data: data,
            });
            return false;
          }
          if (completeRefresh403 < 1) {
            completeRefresh403++;
            if (await ensureTokenRefreshed()) continue;
          }
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message:
                "Upload finalization failed: WAF challenge could not be resolved",
              status: 403,
              data: data,
            });
            return false;
          }
          await handleSafelineOnce();
          continue;
        }

        // 404/405 can briefly occur while the upstream changes color. 409
        // means S3 has not exposed every completed part yet. All these cases,
        // plus proxy/backend pressure, are safe because completion is
        // idempotent and protected by a distributed lock.
        if (
          response.status === 404 ||
          response.status === 405 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          var retryDelay = Math.min(1000 * Math.pow(2, attempt - 1), 15_000);
          retryDelay += Math.floor(Math.random() * 500);
          self.postMessage({
            type: "retrying",
            chunkIndex: totalChunks,
            attempt: attempt,
            maxAttempts: maxCompleteAttempts,
            delayMs: retryDelay,
            httpStatus: response.status,
          });
          await sleep(retryDelay);
          continue;
        }

        self.postMessage({
          type: "error",
          message: (data && data.message) || "Multipart finalization failed",
          status: response.status,
          data: data,
        });
        return false;
      } catch (error) {
        clearTimeout(timer);
        if (aborted) return false;
        if (attempt < maxCompleteAttempts) {
          var networkDelay = Math.min(1000 * Math.pow(2, attempt - 1), 15_000);
          networkDelay += Math.floor(Math.random() * 500);
          self.postMessage({
            type: "retrying",
            chunkIndex: totalChunks,
            attempt: attempt,
            maxAttempts: maxCompleteAttempts,
            delayMs: networkDelay,
            httpStatus: 0,
          });
          await sleep(networkDelay);
          continue;
        }
        self.postMessage({
          type: "error",
          message: (error && error.message) || "Upload finalization failed",
          status: 0,
          data: null,
        });
        return false;
      }
    }

    self.postMessage({
      type: "error",
      message:
        "Upload finalization did not recover after " +
        maxCompleteAttempts +
        " attempts",
      status: 503,
      data: null,
    });
    return false;
  }

  async function requestLegacyDirectPartAuthorization(
    chunkIndex,
    contentLength,
    signal,
  ) {
    var authorizationUrl =
      "/api/shares/" +
      encodeURIComponent(shareId) +
      "/files/multipart/part-url";
    var authorizationRefresh403 = 0;
    var payload = getMultipartControlPayloadObject();
    payload.chunkIndex = chunkIndex;
    payload.contentLength = contentLength;

    for (var attempt = 1; attempt <= 3; attempt++) {
      if (aborted) return { fatal: true };
      try {
        var response = await fetch(authorizationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "include",
          signal: signal,
        });
        var data = null;
        try {
          data = await response.json();
        } catch {
          try {
            response.body && response.body.cancel();
          } catch {}
        }

        if (
          response.ok &&
          data &&
          typeof data.url === "string" &&
          data.contentLength === contentLength
        ) {
          return { ok: true, data: data };
        }
        if (response.status === 401) {
          if (await ensureTokenRefreshed()) continue;
          self.postMessage({
            type: "error",
            message:
              "Session expired. Please log in again and retry the upload.",
            status: 401,
            data: data,
          });
          return { fatal: true };
        }
        if (response.status === 468) {
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message:
                "Upload authorization failed: WAF challenge could not be resolved",
              status: 468,
              data: data,
            });
            return { fatal: true };
          }
          await handleSafelineOnce();
          continue;
        }
        if (response.status === 403) {
          if (data && data.error) {
            self.postMessage({
              type: "error",
              message: data.message || "Upload authorization was denied",
              status: 403,
              data: data,
            });
            return { fatal: true };
          }
          if (authorizationRefresh403 < 1) {
            authorizationRefresh403++;
            if (await ensureTokenRefreshed()) continue;
          }
          safeline468Retries++;
          await handleSafelineOnce();
          continue;
        }
        if (response.status === 413) {
          self.postMessage({
            type: "size-limit-exceeded",
            message: (data && data.message) || "Upload failed (size limit)",
          });
          return { fatal: true };
        }
        if (
          response.status === 404 ||
          response.status === 405 ||
          response.status === 409 ||
          response.status === 415 ||
          response.status === 501
        ) {
          return {
            fallback: true,
            reason: "authorization-http-" + response.status,
          };
        }
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 3) {
            await sleep(250 * Math.pow(2, attempt - 1));
            continue;
          }
          return {
            fallback: true,
            reason: "authorization-http-" + response.status,
          };
        }

        self.postMessage({
          type: "error",
          message:
            (data && data.message) || "Multipart part authorization failed",
          status: response.status,
          data: data,
        });
        return { fatal: true };
      } catch {
        if (aborted) return { fatal: true };
        if (attempt < 2) {
          await sleep(250);
          continue;
        }
        return {
          fallback: true,
          reason:
            "authorization-" +
            (error && error.name ? error.name : "network"),
        };
      }
    }
    return { fallback: true, reason: "authorization-exhausted" };
  }

  var DIRECT_AUTH_BATCH_SIZE = 12;
  var directAuthorizationCache = new Map();
  var directAuthorizationInflight = new Map();
  var batchAuthorizationUnsupported = false;

  async function fetchDirectAuthorizationBatch(indexes, signal) {
    var authorizationUrl =
      "/api/shares/" +
      encodeURIComponent(shareId) +
      "/files/multipart/part-urls";
    var payload = getMultipartControlPayloadObject();
    payload.parts = indexes.map(function (index) {
      return {
        chunkIndex: index,
        contentLength: getExpectedBodyBytes(index),
      };
    });
    var refresh403 = 0;
    var maxAttempts = 8;

    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      if (aborted) return { fatal: true };
      try {
        var response = await fetch(authorizationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "include",
          signal: signal,
        });
        var data = null;
        try {
          data = await response.json();
        } catch {
          try {
            response.body && response.body.cancel();
          } catch {}
        }

        if (response.ok && data) {
          var authorizations = Array.isArray(data.parts)
            ? data.parts
            : Array.isArray(data.authorizations)
              ? data.authorizations
              : [];
          var byIndex = new Map();
          authorizations.forEach(function (item) {
            var itemIndex = Number(item && item.chunkIndex);
            if (!Number.isInteger(itemIndex) && Number.isInteger(item.partNumber)) {
              itemIndex = Number(item.partNumber) - 1;
            }
            if (!indexes.includes(itemIndex)) return;
            var expectedLength = getExpectedBodyBytes(itemIndex);
            if (Number(item.contentLength) !== expectedLength) return;
            byIndex.set(
              itemIndex,
              Object.assign({}, data, item, {
                id: data.id || item.id || fileId,
                contentLength: expectedLength,
              }),
            );
          });
          if (byIndex.size !== indexes.length) {
            self.postMessage({
              type: "error",
              message:
                "Multipart batch authorization returned an incomplete or invalid part set",
              status: 502,
              data: null,
            });
            return { fatal: true };
          }
          applyDirectPoolConfig(data);
          byIndex.forEach(function (authorization, index) {
            directAuthorizationCache.set(index, authorization);
          });
          return { ok: true };
        }

        if (
          response.status === 404 ||
          response.status === 405 ||
          response.status === 415 ||
          response.status === 501
        ) {
          batchAuthorizationUnsupported = true;
          return { fallbackLegacy: true };
        }
        if (response.status === 401) {
          if (await ensureTokenRefreshed()) continue;
          self.postMessage({
            type: "error",
            message:
              "Session expired. Please log in again and retry the upload.",
            status: 401,
            data: data,
          });
          return { fatal: true };
        }
        if (response.status === 468) {
          safeline468Retries++;
          if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
            self.postMessage({
              type: "error",
              message:
                "Upload authorization failed: WAF challenge could not be resolved",
              status: 468,
              data: data,
            });
            return { fatal: true };
          }
          await handleSafelineOnce();
          continue;
        }
        if (response.status === 403) {
          if (data && data.error) {
            self.postMessage({
              type: "error",
              message: data.message || "Upload authorization was denied",
              status: 403,
              data: data,
            });
            return { fatal: true };
          }
          if (refresh403 < 1) {
            refresh403++;
            if (await ensureTokenRefreshed()) continue;
          }
          safeline468Retries++;
          await handleSafelineOnce();
          continue;
        }
        if (response.status === 413) {
          self.postMessage({
            type: "size-limit-exceeded",
            message: (data && data.message) || "Upload failed (size limit)",
          });
          return { fatal: true };
        }
        if (
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          if (attempt < maxAttempts) {
            var retryAfterMs = parseRetryAfterMs(response);
            var delayMs = Math.max(
              retryAfterMs,
              Math.min(500 * Math.pow(2, attempt - 1), 15_000) +
                Math.floor(Math.random() * 750),
            );
            self.postMessage({
              type: "retrying",
              chunkIndex: indexes[0],
              attempt: attempt,
              maxAttempts: maxAttempts,
              delayMs: delayMs,
              httpStatus: response.status,
            });
            await sleep(delayMs);
            continue;
          }
          self.postMessage({
            type: "error",
            message:
              "Direct multipart authorization remained temporarily unavailable",
            status: response.status,
            data: data,
          });
          return { fatal: true };
        }

        self.postMessage({
          type: "error",
          message:
            (data && data.message) || "Multipart batch authorization failed",
          status: response.status,
          data: data,
        });
        return { fatal: true };
      } catch {
        if (aborted) return { fatal: true };
        if (attempt < maxAttempts) {
          var networkDelay =
            Math.min(500 * Math.pow(2, attempt - 1), 15_000) +
            Math.floor(Math.random() * 750);
          await sleep(networkDelay);
          continue;
        }
        self.postMessage({
          type: "error",
          message:
            "Direct multipart authorization could not reach the active backend",
          status: 503,
          data: null,
        });
        return { fatal: true };
      }
    }
    return { fatal: true };
  }

  async function requestDirectPartAuthorization(
    chunkIndex,
    contentLength,
    signal,
  ) {
    if (browserOriginPoolMode && !batchAuthorizationUnsupported) {
      var cached = directAuthorizationCache.get(chunkIndex);
      if (cached && Number(cached.contentLength) === contentLength) {
        return { ok: true, data: cached };
      }
      var inflight = directAuthorizationInflight.get(chunkIndex);
      if (!inflight) {
        var indexes = [];
        for (
          var candidateIndex = chunkIndex;
          candidateIndex < endChunk &&
          indexes.length < DIRECT_AUTH_BATCH_SIZE;
          candidateIndex++
        ) {
          if (
            !completedProgressChunks.has(candidateIndex) &&
            !directAuthorizationCache.has(candidateIndex)
          ) {
            indexes.push(candidateIndex);
          }
        }
        if (indexes.length === 0) indexes.push(chunkIndex);
        inflight = fetchDirectAuthorizationBatch(indexes, signal).finally(
          function () {
            indexes.forEach(function (index) {
              directAuthorizationInflight.delete(index);
            });
          },
        );
        indexes.forEach(function (index) {
          directAuthorizationInflight.set(index, inflight);
        });
      }
      var batchResult = await inflight;
      if (batchResult.fatal) return batchResult;
      if (!batchResult.fallbackLegacy) {
        var authorized = directAuthorizationCache.get(chunkIndex);
        if (authorized && Number(authorized.contentLength) === contentLength) {
          return { ok: true, data: authorized };
        }
        return { fatal: true };
      }
    }
    return requestLegacyDirectPartAuthorization(
      chunkIndex,
      contentLength,
      signal,
    );
  }

  function invalidateDirectAuthorization(chunkIndex) {
    directAuthorizationCache.delete(chunkIndex);
  }

  /**
   * Upload a prepared encrypted/plain part directly to the S3-compatible
   * endpoint. If the browser cannot reach that endpoint (most commonly CORS),
   * the caller safely retries the same part number through Nest; UploadPart
   * replacement semantics make that fallback idempotent even if the direct
   * PUT actually committed but its response was lost.
   */
  async function sendDirectPart(
    chunkIndex,
    getBody,
    releaseBody,
    bodyBytes,
    signal,
  ) {
    for (var authorizationAttempt = 1; authorizationAttempt <= 2; authorizationAttempt++) {
      var authorization = await requestDirectPartAuthorization(
        chunkIndex,
        bodyBytes,
        signal,
      );
      if (!authorization.ok) return authorization;

      var candidates = normalizeDirectCandidates(authorization.data);
      if (candidates.length === 0) {
        return { fallback: true, reason: "storage-no-valid-origin" };
      }
      var refreshAuthorization = false;
      var lastFailureReason = "storage-exhausted";

      for (var candidateAttempt = 0; candidateAttempt < candidates.length; candidateAttempt++) {
        var grant = null;
        var released = false;
        try {
          // Blob reads and E2E encryption may take seconds on a constrained
          // device. Prepare the body before reserving a page-level S3 socket,
          // otherwise sibling file Workers wait behind an idle connection.
          var body = await getBody();
          grant = await acquireDirectSlot(candidates);
          var candidate = candidates[grant.candidateIndex];
          if (!candidate || candidate.origin !== grant.origin) {
            releaseDirectSlot(grant.leaseId, "cancelled", 0);
            released = true;
            return { fallback: true, reason: "storage-invalid-slot-grant" };
          }

          var response = await fetch(candidate.url, {
            method: "PUT",
            body: body,
            credentials: "omit",
            signal: signal,
          });
          if (response.ok) {
            releaseDirectSlot(grant.leaseId, "success", 0);
            released = true;
            invalidateDirectAuthorization(chunkIndex);
            try {
              response.body && response.body.cancel();
            } catch {}
            return { ok: true, data: authorization.data };
          }
          var retryAfterMs = parseRetryAfterMs(response);
          try {
            response.body && response.body.cancel();
          } catch {}
          releaseBody();

          var transient =
            response.status === 403 ||
            response.status === 429 ||
            response.status >= 500;
          releaseDirectSlot(
            grant.leaseId,
            transient ? "transient" : "cancelled",
            retryAfterMs,
          );
          released = true;
          lastFailureReason = "storage-http-" + response.status;
          if (!transient) {
            return { fallback: true, reason: lastFailureReason };
          }
          if (response.status === 403) {
            refreshAuthorization = true;
            invalidateDirectAuthorization(chunkIndex);
          }
        } catch (error) {
          releaseBody();
          if (grant && !released) {
            releaseDirectSlot(grant.leaseId, "network", 0);
            released = true;
          }
          if (aborted) return { fatal: true };
          lastFailureReason =
            "storage-" + (error && error.name ? error.name : "network");
        }
      }

      if (refreshAuthorization && authorizationAttempt < 2) {
        await sleep(250 * authorizationAttempt);
        continue;
      }
      return { fallback: true, reason: lastFailureReason };
    }
    return { fallback: true, reason: "storage-exhausted" };
  }

  // ---- Send a single chunk with full retry/auth/SafeLine handling ----
  // Returns { ok: true } on success, { ok: false } on fatal error
  // (error message already posted to main thread).
  async function sendSingleChunk(chunkIndex) {
    var localRetries = 0; // permanent error counter
    var transientRetries = 0; // transient error counter (502/503/network)
    var recoveryCycles = 0; // how many 2-min recovery pauses we've done
    var sessionMissingRetries = 0;
    var localRefresh403 = 0;
    var initialBodyWaitMs = null;
    var relayCurrentPart = false;

    while (true) {
      if (aborted) {
        self.postMessage({
          type: "error",
          message: "Upload aborted",
          status: 0,
          data: null,
        });
        return { ok: false };
      }

      var body = null;
      var getBodyForTransfer = async function () {
        if (body !== null) return body;
        var bodyWaitStartedAt = performance.now();
        body = await getPreparedBody(chunkIndex);
        if (initialBodyWaitMs === null) {
          initialBodyWaitMs = performance.now() - bodyWaitStartedAt;
        }
        return body;
      };
      var releaseBodyForTransfer = function () {
        body = null;
        releasePreparedBody(chunkIndex);
      };

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
        var bodyBytes = getExpectedBodyBytes(chunkIndex);
        var transferStartedAt = performance.now();
        var response = null;
        var jsonResult = null;

        if (
          uploadTransport === "direct-s3" &&
          !directUploadUnavailable &&
          !relayCurrentPart
        ) {
          var directResult = await sendDirectPart(
            chunkIndex,
            getBodyForTransfer,
            releaseBodyForTransfer,
            bodyBytes,
            controller.signal,
          );
          if (directResult.fatal) {
            clearTimeout(timer);
            body = null;
            return { ok: false };
          }
          if (!directResult.ok) {
            clearTimeout(timer);
            var directFailureReason = directResult.reason || "unknown";
            var permanentDirectFailure =
              directFailureReason === "storage-no-valid-origin" ||
              directFailureReason === "storage-invalid-slot-grant" ||
              /^storage-http-4(?!03|29)/.test(directFailureReason);
            if (permanentDirectFailure) {
              directUploadUnavailable = true;
              uploadTransport = "stream";
              MAX_PARALLEL = Math.max(
                1,
                Math.min(
                  uploadRelayFallbackConcurrency,
                  serverParallelCap,
                  browserParallelCap,
                ),
              );
            } else {
              relayCurrentPart = true;
            }
            console.warn(
              "[upload] direct S3 unavailable -> fallback=nest-stream reason=" +
                directFailureReason +
                " scope=" +
                (permanentDirectFailure ? "file" : "part") +
                " chunk=" +
                chunkIndex,
            );
            continue;
          }
          jsonResult = directResult.data;
          body = null;
          clearTimeout(timer);
        } else {
          var usingRelayFallback =
            browserOriginPoolMode &&
            (directUploadUnavailable || relayCurrentPart);
          var headers = {
            "Content-Type":
              uploadTransport === "stream" || usingRelayFallback
                ? "application/vnd.privcloud.chunk"
                : "application/octet-stream",
            "X-File-Name": encodeURIComponent(fileName),
          };
          if (relativePath) {
            headers["X-File-Relative-Path"] =
              encodeURIComponent(relativePath);
          }

          var relayLeaseId = null;
          try {
            // A relay lease represents an in-flight Nest request, not client
            // CPU work. Keeping preparation outside this critical section lets
            // encryption overlap across files while the server remains capped.
            body = await getBodyForTransfer();
            if (usingRelayFallback) {
              var relayGrant = await acquireRelaySlot();
              relayLeaseId = relayGrant.leaseId;
            }
            var responsePromise = fetch(url, {
              method: "POST",
              headers: headers,
              body: body,
              credentials: "include",
              signal: controller.signal,
            });
            if (chunkIndex === startChunk) {
              // fetch() has synchronously captured the complete chunk-0 body.
              // Use the otherwise idle first network request to prepare phase 2,
              // without sending any later chunk before the multipart id exists.
              prewarmInitialWindow();
            }
            response = await responsePromise;
          } finally {
            if (relayLeaseId) releaseRelaySlot(relayLeaseId);
            if (usingRelayFallback) {
              releaseBodyForTransfer();
            }
          }
          body = null;
          clearTimeout(timer);
        }

        if (response && !response.ok) {
          var httpStatus = response.status;
          var respData = null;
          try {
            respData = await response.json();
          } catch {
            try {
              if (response.body && !response.body.locked)
                response.body.cancel();
            } catch {}
          }
          response = null;
          console.warn(
            "[upload] chunk request failed -> chunk=" +
              chunkIndex +
              " status=" +
              httpStatus +
              " transport=" +
              uploadTransport +
              (respData && typeof respData.message === "string"
                ? " message=" + respData.message.slice(0, 160)
                : ""),
          );

          // A legacy backend or an upstream WAF may reject the negotiated
          // media type. Retry the same chunk on the buffered compatibility
          // path so rolling upgrades do not interrupt active uploads.
          var contentLengthRejected =
            httpStatus === 400 &&
            respData &&
            typeof respData.message === "string" &&
            respData.message.indexOf("Content-Length") !== -1;
          if (
            uploadTransport === "stream" &&
            (httpStatus === 415 || contentLengthRejected)
          ) {
            uploadTransport = "buffered";
            MAX_PARALLEL = Math.min(MAX_PARALLEL, 2);
            continue;
          }

          // 429 -> server busy (S3 upload slots full), retry with backoff
          if (httpStatus === 429) {
            // Back off the shared window immediately. Repeatedly resubmitting
            // the same number of lanes only prolongs backend contention.
            MAX_PARALLEL = Math.max(1, MAX_PARALLEL - 1);
            console.warn(
              "[upload] 429 busy -> lanes=" +
                MAX_PARALLEL +
                " chunk=" +
                chunkIndex,
            );
            localRetries++;
            if (localRetries >= MAX_RETRIES) {
              self.postMessage({
                type: "error",
                message: "Server busy after " + MAX_RETRIES + " retries",
                status: 429,
                data: null,
              });
              return { ok: false };
            }
            await sleep(Math.min(3000 * Math.pow(2, localRetries - 1), 30000));
            continue;
          }

          // 422 unexpected_chunk_index -> retry same chunk
          if (
            httpStatus === 422 &&
            respData &&
            respData.error === "unexpected_chunk_index"
          ) {
            continue;
          }

          // 401 -> access token expired
          if (httpStatus === 401) {
            var refreshOk = await ensureTokenRefreshed();
            if (!refreshOk) {
              self.postMessage({
                type: "error",
                message:
                  "Session expired. Please log in again and retry the upload.",
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
            console.warn(
              "[upload] SafeLine 468 -> retries=" +
                safeline468Retries +
                " chunk=" +
                chunkIndex,
            );
            if (safeline468Retries >= MAX_SAFELINE_468_RETRIES) {
              self.postMessage({
                type: "error",
                message:
                  "Upload failed: WAF challenge could not be resolved after " +
                  MAX_SAFELINE_468_RETRIES +
                  " retries",
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
            if (localRefresh403 < 3) {
              localRefresh403++;
              var refreshOk403 = await ensureTokenRefreshed();
              if (!refreshOk403) {
                self.postMessage({
                  type: "error",
                  message:
                    "Session expired. Please log in again and retry the upload.",
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
                  message:
                    "Upload failed: WAF challenge could not be resolved after " +
                    MAX_SAFELINE_468_RETRIES +
                    " retries",
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
              message:
                (respData && respData.message) ||
                "Upload failed (access denied)",
              status: 403,
              data: respData,
            });
            return { ok: false };
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
            return { ok: false };
          }

          // 500 with "session not found" can happen if HAProxy sends a later
          // chunk to another application process while the S3 multipart
          // upload session is still in memory on the original one. Give ops a
          // short recovery window to put the original color back in DRAIN.
          if (
            httpStatus === 500 &&
            respData &&
            typeof respData.message === "string" &&
            respData.message.indexOf("session not found") !== -1
          ) {
            sessionMissingRetries++;
            if (sessionMissingRetries <= MAX_SESSION_MISSING_RETRIES) {
              var sessionDelay = Math.min(
                5000 * Math.pow(2, sessionMissingRetries - 1),
                30000,
              );
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
              message:
                "Upload session expired on the server. The file must be re-uploaded from the start.",
              status: 500,
              data: respData,
            });
            return { ok: false };
          }

          // CompleteMultipartUpload failed: upload state is uncertain, restart
          // required to avoid committing duplicate or corrupted parts.
          if (
            httpStatus === 500 &&
            respData &&
            typeof respData.message === "string" &&
            respData.message.indexOf("completion failed") !== -1
          ) {
            if (serverManagedWindow && (await finalizeMultipartSession())) {
              if (!completedProgressChunks.has(chunkIndex)) {
                completedProgressChunks.add(chunkIndex);
                var reconciledBounds = getChunkBounds(chunkIndex);
                uploadedPlainBytes += Math.max(
                  0,
                  reconciledBounds.to - reconciledBounds.from,
                );
              }
              self.postMessage({
                type: "progress",
                chunkIndex: chunkIndex,
                totalChunks: totalChunks,
                fileId: fileId,
                uploadedBytes: uploadedPlainBytes,
              });
              return {
                ok: true,
                uploadTransport: uploadTransport,
                uploadConcurrency: MAX_PARALLEL,
              };
            }
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
                message:
                  "Server unavailable after " +
                  MAX_RETRIES_TRANSIENT * (MAX_RECOVERY_CYCLES + 1) +
                  " retries (HTTP 503)",
                status: 503,
                data: respData,
              });
              return { ok: false };
            }
            // Short backoff: 5s, 10s, 20s, 30s, 30s... capped at 30s
            // The S3 multipart session is still alive -- once S3 recovers the retry succeeds.
            var s503Delay = Math.min(
              5000 * Math.pow(2, transientRetries - 1),
              30000,
            );
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
                message:
                  "Server unavailable after " +
                  MAX_RETRIES_TRANSIENT * (MAX_RECOVERY_CYCLES + 1) +
                  " retries (HTTP 502)",
                status: 502,
                data: respData,
              });
              return { ok: false };
            }
            // Backoff with jitter: 5s, 10s, 20s, 40s, 60s... capped at 120s
            var baseDelay = Math.min(
              5000 * Math.pow(2, transientRetries - 1),
              120000,
            );
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
                message:
                  "Upload failed after " +
                  MAX_RETRIES_TRANSIENT * (MAX_RECOVERY_CYCLES + 1) +
                  " retries",
                status: httpStatus,
                data: respData,
              });
              return { ok: false };
            }
            var otherDelay = Math.min(
              5000 * Math.pow(2, transientRetries - 1),
              60000,
            );
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
        if (!jsonResult) {
          jsonResult = await response.json();
        }
        var transferSeconds = Math.max(
          (performance.now() - transferStartedAt) / 1000,
          0.001,
        );
        var observedBps = bodyBytes / transferSeconds;
        response = null;

        if (chunkIndex === startChunk || (chunkIndex - startChunk) % 20 === 0) {
          var prepareTiming = prepareTimings.get(chunkIndex);
          console.info(
            "[upload] timing -> part=" +
              (chunkIndex + 1) +
              " prepareMs=" +
              Math.round(prepareTiming ? prepareTiming.prepareMs : 0) +
              " readMs=" +
              Math.round(prepareTiming ? prepareTiming.readMs : 0) +
              " cryptoMs=" +
              Math.round(prepareTiming ? prepareTiming.cryptoMs : 0) +
              " waitMs=" +
              Math.round(initialBodyWaitMs || 0) +
              " requestMs=" +
              Math.round(transferSeconds * 1000),
          );
        }

        // Refine concurrency from the transfer we actually observed. The
        // former backend feedback field is no longer emitted, so branching on
        // it left a dead control path.
        var aggregateBps = observedBps * MAX_PARALLEL;
        if (
          !serverManagedWindow &&
          chunkIndex > startChunk &&
          uploadTransport === "stream" &&
          MAX_PARALLEL < serverParallelCap &&
          aggregateBps >= 30_000_000
        ) {
          MAX_PARALLEL++;
        }

        fileId = jsonResult.id;
        if (
          serverManagedWindow &&
          !browserOriginPoolMode &&
          jsonResult.uploadWindowMode === "server-adaptive-fair"
        ) {
          applyServerWindow(jsonResult);
        }
        relayCurrentPart = false;
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
        if (
          !serverManagedWindow &&
          uploadTransport === "stream" &&
          MAX_PARALLEL < serverParallelCap &&
          consecutiveOkChunks > 0 &&
          consecutiveOkChunks % 20 === 0
        ) {
          MAX_PARALLEL++;
        }

        if (!completedProgressChunks.has(chunkIndex)) {
          completedProgressChunks.add(chunkIndex);
          var completedBounds = getChunkBounds(chunkIndex);
          uploadedPlainBytes += Math.max(
            0,
            completedBounds.to - completedBounds.from,
          );
        }
        self.postMessage({
          type: "progress",
          chunkIndex: chunkIndex,
          totalChunks: totalChunks,
          fileId: fileId,
          uploadedBytes: uploadedPlainBytes,
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
          self.postMessage({
            type: "error",
            message: "Upload aborted",
            status: 0,
            data: null,
          });
          return { ok: false };
        }
        transientRetries++;
        console.warn(
          "[upload] chunk network failure -> chunk=" +
            chunkIndex +
            " attempt=" +
            transientRetries +
            "/" +
            MAX_RETRIES_TRANSIENT +
            " error=" +
            (e && e.name ? e.name : "NetworkError"),
        );
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
        var netBaseDelay = Math.min(
          5000 * Math.pow(2, transientRetries - 1),
          120000,
        );
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

  // ---- Control plane + data window ----
  var initialization = await initializeMultipartSession();
  if (initialization.fatal) return;
  var nextIdx;
  if (initialization.ready) {
    // The multipart ID already exists on S3: part 1 no longer blocks the rest
    // of the data window. Preparation remains bounded independently.
    initialWindowPrewarmed = true;
    nextIdx = startChunk;
    console.info(
      "[upload] init -> protocol=preinitialized transport=" +
        uploadTransport +
        " clientRevision=" +
        UPLOAD_CLIENT_REVISION +
        " serverConcurrency=" +
        serverParallelCap +
        " globalConcurrency=" +
        serverGlobalCap +
        " activeFlows=" +
        serverActiveFlows +
        " fairShare=" +
        serverFairShare +
        " plannedFlows=" +
        plannedFileConcurrency +
        " hardwareCap=" +
        browserParallelCap +
        " lanes=" +
        MAX_PARALLEL +
        " originCount=" +
        directOriginCount +
        " connectionsPerOrigin=" +
        directConnectionsPerOrigin +
        " cryptoCap=" +
        cryptoParallel +
        " prepareCap=" +
        bodyPrepareParallel +
        " isE2E=" +
        isE2E +
        " chunkSize=" +
        Math.round(chunkSize / 1e6) +
        "MB firstChunkSize=" +
        Math.round(initialChunkSize / 1e6) +
        "MB",
    );
  } else {
    // Mixed-version compatibility: older backends initialize S3 with part 1.
    var result0 = await sendSingleChunk(startChunk);
    if (!result0.ok) return;
    releasePreparedBody(startChunk);

    if (result0.uploadTransport === "stream") {
      uploadTransport = "stream";
    }
    if (!serverManagedWindow || serverGlobalCap === 0) {
      var serverParallel = Number(result0.uploadConcurrency);
      if (Number.isFinite(serverParallel) && serverParallel >= 1) {
        serverParallelCap = Math.min(
          Math.floor(serverParallel),
          browserParallelCap,
        );
        MAX_PARALLEL =
          uploadTransport === "stream"
            ? serverParallelCap
            : Math.min(2, serverParallelCap);
      }
    }
    console.info(
      "[upload] init -> transport=" +
        uploadTransport +
        " serverConcurrency=" +
        result0.uploadConcurrency +
        " browserCap=" +
        browserParallelCap +
        " lanes=" +
        MAX_PARALLEL +
        " cryptoCap=" +
        cryptoParallel +
        " prepareCap=" +
        bodyPrepareParallel +
        " prewarm=" +
        (isE2E
          ? Math.min(browserParallelCap, Math.max(0, endChunk - startChunk - 1))
          : 0) +
        " isE2E=" +
        isE2E +
        " chunkSize=" +
        Math.round(chunkSize / 1e6) +
        "MB firstChunkSize=" +
        Math.round(initialChunkSize / 1e6) +
        "MB",
    );
    nextIdx = startChunk + 1;
  }

  var activeChunks = new Map(); // idx -> Promise<{idx, ok}>

  function launchChunk(idx) {
    var p = sendSingleChunk(idx).then(function (r) {
      releasePreparedBody(idx);
      return { idx: idx, ok: r.ok };
    });
    activeChunks.set(idx, p);
  }

  function prefetchAhead() {
    for (var k = 0; k < PREFETCH_AHEAD; k++) {
      var idx = nextIdx + k;
      if (idx < endChunk) getPreparedBody(idx);
    }
  }

  // Fill initial window
  while (activeChunks.size < MAX_PARALLEL && nextIdx < endChunk) {
    launchChunk(nextIdx++);
  }
  prefetchAhead();

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
    prefetchAhead();
  }

  if (initialization.ready && !(await finalizeMultipartSession())) {
    return;
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
