import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import {
  CONTENT_V2_HEADER_LENGTH,
  CONTENT_V2_OVERHEAD,
  ContentIntegrityError,
  decryptContentV2,
} from "../src/utils/contentV2.util.ts";
import { generateEncryptionKey } from "../src/utils/crypto.util.ts";
import {
  encryptContentV2Chunk,
  openContentV2Writer,
  uploadDirectFile,
} from "../../bridge/src/direct-upload.mjs";

// Every product writer is read back by the reference reader of
// src/utils/contentV2.util.ts, never by a copy of its own code.
const FILE_ID = "6f1d2c7e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";
const workerSource = readFileSync(
  new URL("../public/upload-worker.js", import.meta.url),
  "utf8",
);
const content = (length, seed) =>
  Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const layoutOf = (size, chunkSize) =>
  size > chunkSize
    ? {
        initialChunkSize: 6_000_000,
        totalChunks: 1 + Math.ceil((size - 6_000_000) / chunkSize),
      }
    : { initialChunkSize: chunkSize, totalChunks: 1 };

/** Runs the real upload worker against an in-memory server. */
async function runWorker({
  plain,
  rawKey,
  nonce,
  savedParts = [],
  fileId = FILE_ID,
  serverId = fileId,
  chunkSize = 8_000_000,
}) {
  const { initialChunkSize, totalChunks } = layoutOf(plain.length, chunkSize);
  const bodies = new Map();
  const requests = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const self = {
    navigator: { deviceMemory: 8, hardwareConcurrency: 8 },
    postMessage(message) {
      if (message.type === "batch-complete" || message.type === "error")
        finished(message);
    },
  };
  const window = {
    uploadTransport: "stream",
    uploadWindowMode: "server-adaptive-fair",
    uploadConcurrency: 2,
    uploadGlobalConcurrency: 2,
    uploadFairShare: 2,
    uploadActiveFlows: 1,
  };
  const json = (data) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => data,
  });
  const context = vm.createContext({
    AbortController,
    Date,
    Map,
    Set,
    Math,
    Number,
    Promise,
    Uint8Array,
    TextEncoder,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    encodeURIComponent,
    performance,
    self,
    setTimeout,
  });
  context.fetch = async (url, options) => {
    const parsed = new URL(url, "https://fixture.test");
    if (parsed.pathname.endsWith("/multipart/init")) {
      requests.push({ path: "init", body: JSON.parse(options.body) });
      return json({ id: serverId, ...window, uploadedParts: savedParts });
    }
    if (parsed.pathname.endsWith("/multipart/complete")) {
      requests.push({ path: "complete", body: JSON.parse(options.body) });
      return json({ id: serverId, uploadComplete: true });
    }
    const index = Number(parsed.searchParams.get("chunkIndex"));
    requests.push({ path: "chunk", query: parsed.searchParams });
    bodies.set(index, new Uint8Array(options.body));
    return json({ id: serverId, ...window });
  };
  vm.runInContext(workerSource, context);
  self.onmessage({
    data: {
      type: "start",
      shareId: "share-1",
      file: new Blob([plain]),
      chunkSize,
      initialChunkSize,
      totalChunks,
      isE2E: true,
      cryptoKeyRaw: rawKey.slice().buffer,
      cryptoChunkSize: 1_000_000,
      fileId,
      fileName: "file",
      startChunk: 0,
      endChunk: totalChunks,
      serverManagedWindow: true,
      contentScheme: 2,
      contentNonce: nonce.slice().buffer,
    },
  });
  let timer;
  const message = await Promise.race([
    done,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("worker timeout")), 20_000);
    }),
  ]).finally(() => clearTimeout(timer));
  return { message, bodies, requests, totalChunks };
}

async function keyPair() {
  const key = await generateEncryptionKey();
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return { key, raw };
}

const assembled = (bodies, totalChunks) =>
  concat(Array.from({ length: totalChunks }, (_, index) => bodies.get(index)));

test("the web upload worker writes v2 that the reader accepts, across parts", async () => {
  const { key, raw } = await keyPair();
  const plain = content(18_000_017, 1);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const run = await runWorker({ plain, rawKey: raw, nonce });
  assert.equal(run.message.type, "batch-complete", run.message.message);
  assert.equal(run.totalChunks, 3);
  assert.equal(
    run.bodies.get(0).length,
    CONTENT_V2_HEADER_LENGTH + 6_000_000 + 6 * CONTENT_V2_OVERHEAD,
  );
  assert.deepEqual(run.bodies.get(0).subarray(14, 30), nonce);
  const init = run.requests.find((request) => request.path === "init");
  assert.equal(init.body.contentScheme, 2);
  assert.equal(init.body.encryptionChunkSize, 1_000_000);
  for (const request of run.requests.filter((r) => r.path === "chunk")) {
    assert.equal(request.query.get("contentScheme"), "2");
  }
  const stored = assembled(run.bodies, run.totalChunks);
  assert.deepEqual(
    await decryptContentV2(key, { fileId: FILE_ID }, stored),
    plain,
  );
  await assert.rejects(
    decryptContentV2(key, { fileId: "another-file" }, stored),
    ContentIntegrityError,
  );
});

test("the web upload worker writes single-part and empty v2 files", async () => {
  const { key, raw } = await keyPair();
  for (const size of [0, 1, 70_000, 1_000_000, 8_000_000]) {
    const plain = content(size, 2);
    const run = await runWorker({
      plain,
      rawKey: raw,
      nonce: crypto.getRandomValues(new Uint8Array(16)),
    });
    assert.equal(run.message.type, "batch-complete", `size ${size}`);
    const stored = assembled(run.bodies, run.totalChunks);
    assert.deepEqual(
      await decryptContentV2(key, { fileId: FILE_ID }, stored),
      plain,
      `size ${size}`,
    );
  }
});

test("a resumed web upload only completes a file under the nonce of its first session", async () => {
  const { key, raw } = await keyPair();
  const plain = content(18_000_017, 3);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const first = await runWorker({ plain, rawKey: raw, nonce });
  const savedParts = [0, 1].map((index) => ({
    partNumber: index + 1,
    size: first.bodies.get(index).length,
  }));
  const resumed = await runWorker({ plain, rawKey: raw, nonce, savedParts });
  assert.equal(resumed.message.type, "batch-complete");
  assert.deepEqual([...resumed.bodies.keys()], [2]);
  const stored = concat([
    first.bodies.get(0),
    first.bodies.get(1),
    resumed.bodies.get(2),
  ]);
  assert.deepEqual(
    await decryptContentV2(key, { fileId: FILE_ID }, stored),
    plain,
  );
  const otherNonce = await runWorker({
    plain,
    rawKey: raw,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
    savedParts,
  });
  await assert.rejects(
    decryptContentV2(
      key,
      { fileId: FILE_ID },
      concat([
        first.bodies.get(0),
        first.bodies.get(1),
        otherNonce.bodies.get(2),
      ]),
    ),
    ContentIntegrityError,
  );
});

test("the web upload worker stops when the server assigns another file id", async () => {
  const { raw } = await keyPair();
  const run = await runWorker({
    plain: content(18_000_017, 4),
    rawKey: raw,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
    serverId: "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(run.message.type, "error");
  assert.match(run.message.message, /another file id/);
  assert.equal(run.bodies.size, 0);
  const single = await runWorker({
    plain: content(70_000, 4),
    rawKey: raw,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
    serverId: "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(single.message.type, "error");
});

test("the Companion writer produces v2 chunks the reader accepts", async () => {
  const { key, raw } = await keyPair();
  for (const size of [0, 5, 8_000_000, 18_000_017]) {
    const plain = content(size, 5);
    const writer = openContentV2Writer(Buffer.from(raw), FILE_ID, size);
    const parts = [];
    for (let offset = 0; offset < Math.max(size, 1); offset += 8_000_000) {
      parts.push(
        encryptContentV2Chunk(
          writer,
          Buffer.from(plain.subarray(offset, offset + 8_000_000)),
          offset,
        ),
      );
    }
    assert.deepEqual(
      await decryptContentV2(key, { fileId: FILE_ID }, concat(parts)),
      plain,
      `size ${size}`,
    );
  }
});

test("the Companion direct S3 upload declares v2 and sends the parts it sealed", async () => {
  const { key, raw } = await keyPair();
  const plain = content(18_000_017, 6);
  const chunkSize = 8_000_000;
  const writer = openContentV2Writer(Buffer.from(raw), FILE_ID, plain.length);
  let offset = 0;
  const puts = new Map();
  const layouts = [];
  const fetchImpl = async (url, options) => {
    const target = String(url);
    if (options.method === "PUT") {
      puts.set(target, new Uint8Array(options.body));
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(options.body);
    layouts.push(body);
    if (target.endsWith("/init"))
      return Response.json({
        uploadTransport: "direct-s3",
        uploadConcurrency: 2,
      });
    if (target.endsWith("/part-urls")) {
      const [part] = body.parts;
      return Response.json({
        parts: [
          {
            partNumber: part.chunkIndex + 1,
            contentLength: part.contentLength,
            url: `https://storage.test/part-${part.chunkIndex}`,
          },
        ],
      });
    }
    return Response.json({ uploadComplete: true });
  };
  async function* chunks() {
    for (let start = 0; start < plain.length; start += chunkSize)
      yield Buffer.from(plain.subarray(start, start + chunkSize));
  }
  const direct = await uploadDirectFile({
    appBaseUrl: "https://app.test",
    shareId: "share-1",
    uploadToken: "token",
    metadata: { id: FILE_ID, name: "file" },
    fileSize: plain.length,
    chunkSize,
    encrypted: true,
    contentScheme: 2,
    chunks: chunks(),
    transform: (part) => {
      const sealed = encryptContentV2Chunk(writer, part, offset);
      offset += part.length;
      return sealed;
    },
    fetchImpl,
  });
  assert.equal(direct, true);
  assert.ok(layouts.every((layout) => layout.contentScheme === 2));
  assert.ok(
    layouts.every((layout) => layout.encryptionChunkSize === 1_000_000),
  );
  const stored = concat(
    [0, 1, 2].map((index) => puts.get(`https://storage.test/part-${index}`)),
  );
  assert.deepEqual(
    await decryptContentV2(key, { fileId: FILE_ID }, stored),
    plain,
  );
});

test("the production worker seals a UUIDv8 context used by new files in historical shares", async () => {
  const { key, raw } = await keyPair();
  const fileId = "01234567-89ab-8def-89ab-0123456789ab";
  const plain = content(1_000_003, 9);
  const run = await runWorker({
    plain,
    rawKey: raw,
    fileId,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
  assert.equal(run.message.type, "batch-complete");
  assert.deepEqual(
    await decryptContentV2(
      key,
      { fileId },
      assembled(run.bodies, run.totalChunks),
    ),
    plain,
  );
});
