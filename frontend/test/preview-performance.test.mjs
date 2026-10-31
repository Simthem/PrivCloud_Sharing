import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewByteSource } from "../src/utils/previewRange.util.ts";
import {
  encryptFile,
  generateEncryptionKey,
} from "../src/utils/crypto.util.ts";
import {
  CONTENT_V2_HEADER_LENGTH,
  encryptContentV2,
} from "../src/utils/contentV2.util.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function transport(stored, recordSize, latency = 0) {
  const reads = [];
  let active = 0,
    peak = 0;
  return {
    reads,
    get peak() {
      return peak;
    },
    async fetch(start, end, signal) {
      signal?.throwIfAborted();
      reads.push([start, end]);
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, latency);
          signal?.addEventListener("abort", abort, { once: true });
        });
        return new Response(stored.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${stored.length}`,
            ...(recordSize
              ? { "X-Encryption-Chunk-Size": String(recordSize) }
              : {}),
          },
        });
      } finally {
        active--;
      }
    },
  };
}

test("nearby MP4 headers share a small network window without transferring its cache", async () => {
  const stored = new Uint8Array(4 * 1024 * 1024).fill(31);
  const network = transport(stored, undefined, 10);
  const source = await createPreviewByteSource(network.fetch);
  const began = performance.now();
  for (let i = 0; i < 12; i++) {
    const bytes = await source.read(i * 32, i * 32 + 16);
    assert.deepEqual(bytes, stored.slice(i * 32, i * 32 + 16));
    structuredClone(bytes, { transfer: [bytes.buffer] });
  }
  assert.equal(
    network.reads.length,
    2,
    "metadata plus one shared header window",
  );
  assert.ok(network.reads.reduce((sum, [a, b]) => sum + b - a + 1, 0) <= 65537);
  console.log(
    `12 MP4 header reads at 10 ms RTT: ${Math.round(performance.now() - began)} ms, one network window`,
  );
});

test("audio, video and seeking reuse authenticated records and load independent records concurrently", async () => {
  const key = await generateEncryptionKey();
  const plain = new Uint8Array(4_000_000).map((_, i) => i % 251);
  const records = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      encryptFile(plain.slice(i * 1_000_000, (i + 1) * 1_000_000).buffer, key),
    ),
  );
  const stored = new Uint8Array(4_000_112);
  records.forEach((record, i) =>
    stored.set(new Uint8Array(record), i * 1_000_028),
  );
  const network = transport(stored, 1_000_000, 20);
  const source = await createPreviewByteSource(network.fetch, key);
  const ranges = [0, 1_000_000, 2_000_000];
  const bytes = await Promise.all(
    ranges.map((start) => source.read(start, start + 100)),
  );
  bytes.forEach((read, i) =>
    assert.deepEqual(read, plain.slice(ranges[i], ranges[i] + 100)),
  );
  assert.equal(network.peak, 3, "independent authenticated reads overlap");
  for (let i = 0; i < 8; i++) {
    const start = (i % 2) * 2_000_000;
    assert.deepEqual(
      await source.read(start, start + 100),
      plain.slice(start, start + 100),
    );
  }
  assert.equal(
    network.reads.length,
    4,
    "metadata plus three records, no seek redownloads",
  );
});

test("cancelling one overlapping media request leaves its other reader usable", async () => {
  const network = transport(new Uint8Array(2_000_000).fill(7), undefined, 30);
  const source = await createPreviewByteSource(network.fetch);
  const leaving = new AbortController();
  const cancelled = source.read(10, 20, leaving.signal);
  const continuing = source.read(15, 25);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  await delay(5);
  leaving.abort();
  await rejected;
  assert.deepEqual(await continuing, new Uint8Array(10).fill(7));
  assert.equal(network.reads.length, 2, "both readers share the network read");
});

test("closing the preview cancels active and queued work, with at most three network reads", async () => {
  const lifetime = new AbortController();
  const network = transport(new Uint8Array(12 * 1024 * 1024), undefined, 30);
  const source = await createPreviewByteSource(
    network.fetch,
    undefined,
    10_000_000,
    lifetime.signal,
  );
  const jobs = Array.from({ length: 10 }, (_, i) =>
    source.read(i * 1024 * 1024, i * 1024 * 1024 + 16),
  );
  const settled = Promise.allSettled(jobs);
  await delay(5);
  lifetime.abort();
  const results = await settled;
  assert.ok(
    results.every(
      (result) =>
        result.status === "rejected" && result.reason.name === "AbortError",
    ),
  );
  assert.equal(network.peak, 3);
  assert.equal(
    network.reads.length,
    4,
    "queued reads never reach the network after close",
  );
  await assert.rejects(source.read(0, 10), { name: "AbortError" });
});

test("the preview evicts old windows instead of retaining a whole large file", async () => {
  const size = 40 * 1024 * 1024;
  const reads = [];
  const source = await createPreviewByteSource(async (start, end) => {
    reads.push(start);
    return new Response(new Uint8Array(end - start + 1).fill(9), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  });
  for (let i = 0; i < 30; i++)
    await source.read(i * 1024 * 1024, (i + 1) * 1024 * 1024);
  const count = reads.length;
  await source.read(29 * 1024 * 1024, 30 * 1024 * 1024);
  assert.equal(reads.length, count, "recent playback remains cached");
  await source.read(0, 1024 * 1024);
  assert.equal(reads.length, count + 1, "old playback was evicted");
});

test("exact encrypted metadata avoids the legacy configuration request", async () => {
  const key = await generateEncryptionKey();
  const stored = new Uint8Array(
    await encryptFile(new Uint8Array(1_000_000).fill(11).buffer, key),
  );
  const network = transport(stored, 1_000_000);
  const source = await createPreviewByteSource(network.fetch, key, async () => {
    throw new Error("legacy configuration must not load");
  });
  assert.deepEqual(await source.read(0, 10), new Uint8Array(10).fill(11));
  let legacyCalls = 0;
  const legacy = transport(stored);
  const old = await createPreviewByteSource(legacy.fetch, key, async () => {
    legacyCalls++;
    return 1_000_000;
  });
  assert.deepEqual(await old.read(0, 10), new Uint8Array(10).fill(11));
  assert.equal(legacyCalls, 1, "legacy layouts still request their fallback");
});

test("media prefetch overlaps the next authenticated v2 records and serves them from memory", async () => {
  const key = await generateEncryptionKey();
  const context = { fileId: "v2.f1", shareId: "v2.s1" };
  const plain = new Uint8Array(6_000_000).map((_, i) => (i * 7) % 253);
  const stored = await encryptContentV2(key, context, plain);
  const network = transport(stored, undefined, 40);
  const source = await createPreviewByteSource(
    network.fetch,
    key,
    undefined,
    undefined,
    context,
  );
  const ahead = new AbortController();
  assert.deepEqual(await source.read(0, 1024), plain.slice(0, 1024));
  const before = network.reads.length;
  source.prefetch(1024, 6_000_000, ahead.signal);
  await delay(400);
  assert.equal(network.peak, 3, "prefetch keeps the existing concurrency");
  const loaded = network.reads.length;
  assert.equal(loaded - before, 5, "the five following records, once each");
  for (let start = 1024; start < 6_000_000; start += 1024 * 1024) {
    const end = Math.min(6_000_000, start + 1024 * 1024);
    assert.deepEqual(await source.read(start, end), plain.slice(start, end));
  }
  assert.equal(network.reads.length, loaded, "playback reads hit the cache");
  assert.ok(
    network.reads.every(([s]) => s === 0 || s >= CONTENT_V2_HEADER_LENGTH),
  );
});

test("media prefetch stays within half the cache and stops when its stream closes", async () => {
  const size = 64 * 1024 * 1024;
  const network = transport(new Uint8Array(size).fill(5), undefined, 30);
  const source = await createPreviewByteSource(network.fetch);
  const bounded = new AbortController();
  source.prefetch(0, size, bounded.signal);
  await delay(500);
  assert.equal(
    network.reads.length - 1,
    12,
    "24 MiB budget, 12 MiB prepared ahead at most",
  );

  const closed = new AbortController();
  const started = network.reads.length;
  source.prefetch(32 * 1024 * 1024, 40 * 1024 * 1024, closed.signal);
  await delay(5);
  closed.abort();
  await delay(200);
  assert.ok(
    network.reads.length - started <= 3,
    "queued windows never reach the network after the stream closed",
  );
});
