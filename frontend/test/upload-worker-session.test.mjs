import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const FILE_ID = "b53173ae-a482-4d17-b952-246df7317c8a";
const CHUNK_BYTES = 50_000_000;
const FIRST_BYTES = 32_000_000;

// Drive the real worker protocol without allocating or sending the virtual file.
// Timers advance only after network promises and worker messages have settled.
async function transfer(options = {}) {
  const size = options.size ?? 361_700_000_000;
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const firstBytes = options.firstBytes ?? FIRST_BYTES;
  const totalChunks = 1 + Math.ceil((size - firstBytes) / chunkBytes);
  const partSize = index => Math.min(index === 0 ? firstBytes : chunkBytes, size - (index === 0 ? 0 : firstBytes + (index - 1) * chunkBytes));
  const wireSize = index => partSize(index) + (options.isE2E ? Math.ceil(partSize(index) / 500_000) * 28 : 0);
  let now = 0,
    sequence = 0,
    terminal,
    refreshed = false,
    complete = false,
    blockedEpisode,
    initialWindowApplied = false;
  const timers = new Map(),
    messages = [],
    uploaded = new Map();
  const challenges = new Set();
  const stats = {
    refreshes: 0,
    challenges: 0,
    completions: 0,
    relays: 0,
    reads: 0,
    storageActive: 0,
    beforeFirstStorageCompletion: 0,
    storageCompletions: 0,
    firstStorageCompletionAt: null,
    lastStorageCompletion: null,
    idleGaps: [],
    authorizationRequests: 0,
    firstReads: new Map(),
  };
  const schedule = (fn, delay) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, fn });
    return id;
  };
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => data,
    body: { cancel: async () => {} },
  });
  const html = (status) => ({
    ...json(null, status),
    headers: { get: () => "text/html" },
    json: async () => {
      throw new SyntaxError("HTML challenge");
    },
  });
  const pool = {
    id: FILE_ID,
    uploadTransport: "direct-s3",
    uploadWindowMode: "browser-origin-pool",
    uploadConcurrency: 6,
    uploadGlobalConcurrency: 6,
    uploadOriginCount: 1,
    uploadConnectionsPerOrigin: 6,
    uploadMaxConcurrency: 6,
    uploadedParts: (options.savedIndexes ?? []).map(index => ({ partNumber: index + 1, size: wireSize(index) })),
  };
  for (const index of options.savedIndexes ?? []) uploaded.set(index, wireSize(index));
  const self = {
    navigator: { deviceMemory: 8, hardwareConcurrency: 8 },
    postMessage(message) {
      messages.push(message);
      if (message.type === "direct-pool-config" && options.initialWindow && !initialWindowApplied) {
        initialWindowApplied = true;
        self.onmessage({ data: { type: "direct-window-update", maxParallel: options.initialWindow } });
      }
      if (
        [
          "batch-complete",
          "error",
          "quota-exceeded",
          "size-limit-exceeded",
        ].includes(message.type)
      )
        terminal = message;
      if (message.type === "need-token-refresh") {
        stats.refreshes++;
        schedule(() => {
          const transient =
            (options.transientRefresh && stats.refreshes === 1) ||
            stats.refreshes <= (options.transientRefreshFailures ?? 0);
          refreshed = !options.refreshDenied && !transient;
          self.onmessage({
            data: {
              type: refreshed ? "token-refresh-done" : "token-refresh-failed",
              status: options.refreshDenied ? 401 : transient ? 468 : 200,
            },
          });
        }, options.refreshDelay ?? 45_000);
      }
      if (message.type === "need-safeline-challenge") {
        stats.challenges++;
        schedule(() => {
          challenges.add(blockedEpisode);
          blockedEpisode = undefined;
          self.onmessage({ data: { type: "safeline-resolved" } });
        }, options.challengeDelay ?? 20_000);
      }
      if (message.type === "acquire-direct-slot") {
        schedule(
          () =>
            self.onmessage({
              data: {
                type: "direct-slot-granted",
                requestId: message.requestId,
                leaseId: message.requestId,
                candidateIndex: 0,
                origin: "https://storage.example.test",
              },
            }),
          0,
        );
      }
      if (message.type === "acquire-relay-slot") {
        schedule(
          () =>
            self.onmessage({
              data: {
                type: "relay-slot-granted",
                requestId: message.requestId,
                leaseId: message.requestId,
              },
            }),
          0,
        );
      }
    },
  };
  const fetch = async (url, init) => {
    assert.equal(
      init.signal?.aborted,
      false,
      "request reused an expired transfer deadline",
    );
    const parsed = new URL(url, "https://app.example.test");
    if (parsed.pathname.endsWith("/multipart/init")) {
      if (options.wafControlStage === "init" && !challenges.has("init")) {
        blockedEpisode = "init";
        return html(401);
      }
      return json(pool);
    }
    if (parsed.pathname.endsWith("/multipart/part-urls")) {
      const payload = JSON.parse(init.body);
      const index = payload.parts[0].chunkIndex;
      if (options.wafControlStage === "authorization" && !challenges.has("authorization")) {
        blockedEpisode = "authorization";
        return html(401);
      }
      if (options.authAt !== undefined && index >= options.authAt && !refreshed)
        return json({ message: "Unauthorized" }, 401);
      if (options.denied)
        return json(
          { error: "Forbidden", message: "Access denied" },
          options.denied,
        );
      const episode = Math.floor(index / 800);
      if (options.repeatedChallenges && !challenges.has(episode)) {
        blockedEpisode = episode;
        return episode % 3 === 0
          ? html(200)
          : html(episode % 3 === 1 ? 468 : 403);
      }
      for (const part of payload.parts) assert.equal((options.savedIndexes ?? []).includes(part.chunkIndex), false, "saved part was authorized again");
      stats.authorizationRequests++;
      if (options.authorizationDelay) await new Promise((resolve) => schedule(resolve, options.authorizationDelay));
      return json({
        ...pool,
        parts: payload.parts.map(({ chunkIndex, contentLength }) => ({
          chunkIndex,
          contentLength,
          partNumber: chunkIndex + 1,
          url: `https://storage.example.test/part/${chunkIndex}`,
        })),
      });
    }
    if (parsed.origin === "https://storage.example.test") {
      const index = Number(parsed.pathname.split("/").pop());
      if (options.storageDelay) {
        if (stats.storageActive === 0 && stats.lastStorageCompletion !== null) stats.idleGaps.push(now - stats.lastStorageCompletion);
        stats.storageActive++;
        if (stats.storageCompletions === 0) stats.beforeFirstStorageCompletion = Math.max(stats.beforeFirstStorageCompletion, stats.storageActive);
        if (index === 0 && options.growWindow) schedule(() => self.onmessage({ data: { type: "direct-window-update", maxParallel: 6 } }), 2000);
        await new Promise((resolve) => schedule(resolve, options.storageDelay));
        stats.storageActive--;
        stats.storageCompletions++;
        if (stats.firstStorageCompletionAt === null) stats.firstStorageCompletionAt = now;
        stats.lastStorageCompletion = now;
      }
      assert.equal(uploaded.has(index), false, "saved part was uploaded again");
      uploaded.set(index, init.body.size ?? init.body.byteLength);
      return json({});
    }
    if (parsed.pathname.endsWith("/multipart/complete")) {
      stats.completions++;
      if (options.wafControlStage === "complete" && !challenges.has("complete")) {
        blockedEpisode = "complete";
        return html(401);
      }
      if (options.completionHtml && stats.completions === 1) return html(200);
      if (options.completionUnconfirmed) return json({ id: FILE_ID });
      if (options.lostCompletion && stats.completions === 1)
        return json({}, 503);
      assert.equal(uploaded.size, totalChunks);
      assert.equal(
        [...uploaded.values()].reduce((sum, value) => sum + value, 0),
        Array.from({ length: totalChunks }, (_, index) => wireSize(index)).reduce((sum, value) => sum + value, 0),
      );
      complete = true;
      return json({ id: FILE_ID, uploadComplete: true });
    }
    stats.relays++;
    return json({
      id: FILE_ID,
      uploadTransport: "stream",
      uploadWindowMode: "server-adaptive-fair",
      uploadConcurrency: 1,
    });
  };
  self.fetch = fetch;
  const context = vm.createContext({
    self,
    fetch,
    AbortController,
    Uint8Array,
    Map,
    Set,
    Number,
    Math,
    Promise,
    crypto: options.isE2E ? {
      randomUUID: () => globalThis.crypto.randomUUID(),
      getRandomValues: array => globalThis.crypto.getRandomValues(array),
      subtle: { importKey: async () => ({}), encrypt: async (_algorithm, _key, plain) => new Uint8Array(plain.byteLength + 16).buffer },
    } : globalThis.crypto,
    encodeURIComponent,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    performance: { now: () => now },
    setTimeout: (fn, delay) => schedule(fn, options.clampWorkerTimers ? Math.max(delay, 60_000) : delay),
    clearTimeout: (id) => timers.delete(id),
    console: { info() {}, warn() {}, error() {}, log() {} },
  });
  vm.runInContext(
    readFileSync(
      new URL("../public/upload-worker.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  self.onmessage({
    data: {
      type: "start",
      shareId: "own-share",
      fileId: FILE_ID,
      fileName: "fixture.bin",
      chunkSize: chunkBytes,
      initialChunkSize: firstBytes,
      totalChunks,
      maxParallelLanes: 6,
      serverManagedWindow: true,
      isE2E: !!options.isE2E,
      cryptoKeyRaw: options.isE2E ? new Uint8Array(32).buffer : undefined,
      cryptoChunkSize: 500_000,
      preparedBodyLookahead: options.preparedBodyLookahead,
      file: {
        size,
        slice(from, to) {
          assert.ok(from >= 0 && to <= size && to > from);
          stats.reads++;
          const index = from < firstBytes ? 0 : 1 + Math.floor((from - firstBytes) / chunkBytes);
          assert.equal((options.savedIndexes ?? []).includes(index), false, "saved bytes were read again");
          return { size: to - from, async arrayBuffer() {
            if (!stats.firstReads.has(index)) stats.firstReads.set(index, now);
            if (options.prepareDelay) await new Promise(resolve => schedule(resolve, options.prepareDelay));
            return new ArrayBuffer(to - from);
          } };
        },
      },
    },
  });
  for (let step = 0; !terminal && step < 30_000; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (terminal) break;
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next, "worker stalled with no pending timer");
    timers.delete(next[0]);
    now = next[1].at;
    next[1].fn();
  }
  assert.ok(terminal, "worker did not settle");
  return { terminal, messages, stats, uploaded, totalChunks, complete, now };
}

test("361.7 GB crosses 17.8 GB and renews authentication while the WAF takes 45 seconds", async () => {
  const f = await transfer({ authAt: 356 });
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.complete, true);
  assert.equal(f.uploaded.size, f.totalChunks);
  assert.equal(f.stats.refreshes, 1);
  assert.equal(f.stats.relays, 0);
});

test("released sibling slots refill a live worker immediately while authorizations are cached", async () => {
  const f = await transfer({ size: 632_000_000, initialWindow: 1, growWindow: true, storageDelay: 10_000 });
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.stats.beforeFirstStorageCompletion, 6, "window update waited for another API response");
  assert.ok(f.now < 40_000, `Unused sockets stretched the transfer to ${f.now}ms`);
});

test("a long direct upload survives repeated 468, HTML 403 and HTML 200 challenges", async () => {
  const f = await transfer({ repeatedChallenges: true, lostCompletion: true });
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.complete, true);
  assert.ok(
    f.stats.challenges >= 9,
    `Only ${f.stats.challenges} challenge renewals`,
  );
  assert.equal(f.stats.relays, 0);
  assert.equal(f.stats.completions, 2);
});

test("HTTP 200 HTML at completion is solved and retried before acknowledging the file", async () => {
  const f = await transfer({ size: 132_000_000, completionHtml: true });
  assert.equal(f.complete, true);
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.stats.completions, 2);
  assert.equal(f.stats.challenges, 1);
});

test("JSON without the storage completion marker cannot acknowledge a file", async () => {
  const f = await transfer({ size: 132_000_000, completionUnconfirmed: true });
  assert.equal(f.terminal.type, "error");
  assert.equal(f.complete, false);
  assert.equal(f.stats.challenges, 0);
});

test("confirmed authentication and authorization failures still stop the transfer", async () => {
  for (const options of [
    { authAt: 0, refreshDenied: true },
    { denied: 403 },
    { denied: 413 },
  ]) {
    const f = await transfer({ size: 132_000_000, ...options });
    assert.notEqual(f.terminal.type, "batch-complete");
    assert.equal(f.complete, false);
    assert.equal(f.stats.challenges, 0);
    assert.equal(f.uploaded.size, 0);
  }
});

test("a transient WAF failure while refreshing retries automatically in the same worker", async () => {
  const f = await transfer({
    size: 132_000_000,
    authAt: 0,
    transientRefresh: true,
  });
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.complete, true);
  assert.equal(f.stats.refreshes, 2);
});

test("unavailable renewal remains retryable without claiming that authentication expired", async () => {
  for (const options of [
    { transientRefreshFailures: 4, expectedStatus: 468 },
    { refreshDelay: 270_000, expectedStatus: 503 },
  ]) {
    const f = await transfer({ size: 132_000_000, authAt: 0, ...options });
    assert.equal(f.terminal.type, "error");
    assert.equal(f.terminal.status, options.expectedStatus);
    assert.doesNotMatch(f.terminal.message, /Session expired/);
    assert.equal(f.complete, false);
  }
});


test("HTML 401 control responses renew WAF without cycling valid account tokens", async () => {
  for (const wafControlStage of ["init", "authorization", "complete"]) {
    const f = await transfer({ size: 132_000_000, wafControlStage });
    assert.equal(f.terminal.type, "batch-complete", wafControlStage);
    assert.equal(f.complete, true);
    assert.equal(f.stats.challenges, 1, wafControlStage);
    assert.equal(f.stats.refreshes, 0, wafControlStage);
    assert.equal(f.stats.relays, 0);
  }
});


test("the next authorization batch arrives while cached parts still transfer", async () => {
  const f = await transfer({ size: 1_982_000_000, storageDelay: 1_000, authorizationDelay: 2_000 });
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.stats.authorizationRequests, Math.ceil(f.totalChunks / 12));
  assert.ok(Math.max(0, ...f.stats.idleGaps) < 1_000, `API authorization left all sockets idle for ${Math.max(...f.stats.idleGaps)}ms`);
  assert.equal(f.stats.relays, 0);
});


test("a verified control reply wakes the worker even when its timers are clamped", async () => {
  for (const renewal of [{ authAt: 0, refreshDelay: 1_000 }, { wafControlStage: "init", challengeDelay: 1_000 }]) {
    const f = await transfer({ size: 132_000_000, clampWorkerTimers: true, ...renewal });
    assert.equal(f.terminal.type, "batch-complete");
    assert.ok(f.now < 5_000, `The verified response waited until ${f.now}ms for a timer`);
  }
});


test("one bounded E2E lookahead overlaps reading with PUT and can be disabled for native buffers", async () => {
  const common = { size: 7_000_000, chunkBytes: 1_000_000, firstBytes: 1_000_000, isE2E: true, initialWindow: 1, prepareDelay: 2_000, storageDelay: 1_000 };
  const buffered = await transfer(common);
  const native = await transfer({ ...common, preparedBodyLookahead: false });
  assert.equal(buffered.terminal.type, "batch-complete");
  assert.equal(native.terminal.type, "batch-complete");
  assert.equal(buffered.complete, true); assert.equal(native.complete, true);
  assert.ok(buffered.stats.firstReads.get(1) < buffered.stats.firstStorageCompletionAt, "next ciphertext was not prepared during the live PUT");
  assert.ok(native.stats.firstReads.get(1) >= native.stats.firstStorageCompletionAt, "native buffers gained an extra body");
  assert.ok(buffered.now < native.now, "ciphertext preparation left the network idle");
  assert.equal(buffered.stats.reads, 7, "lookahead read the same bytes more than once");
});

test("authorization lookahead skips saved batches and handles a resumed batch boundary", async () => {
  const savedIndexes = [0, 1, 2, 3, 4, ...Array.from({ length: 12 }, (_, i) => 12 + i)];
  const f = await transfer({ size: 1_782_000_000, savedIndexes, storageDelay: 1_000, authorizationDelay: 2_000 });
  assert.equal(f.terminal.type, "batch-complete");
  assert.equal(f.stats.reads, f.totalChunks - savedIndexes.length);
  assert.equal(f.stats.authorizationRequests, 2);
  assert.equal(f.stats.relays, 0);
});
