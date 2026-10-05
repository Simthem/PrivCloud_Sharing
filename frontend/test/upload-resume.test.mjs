import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { generateEncryptionKey } from "../src/utils/crypto.util.ts";
import {
  fingerprintUploadFile,
  rememberUploadResumeEntry,
  readUploadResumeEntries,
  matchUploadResumeEntry,
  forgetUploadResumeEntry,
} from "../src/utils/uploadResume.util.ts";
test("resume metadata is encrypted, bound to its share and rejected with the wrong key or file", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map();
  globalThis.localStorage = {
    setItem: (k, v) => store.set(k, v),
    getItem: (k) => store.get(k) ?? null,
    removeItem: (k) => store.delete(k),
    key: (n) => [...store.keys()][n],
    get length() {
      return store.size;
    },
  };
  try {
    const key = await generateEncryptionKey();
    const file = new File(["private document"], "confidential.txt", {
      lastModified: 123,
    });
    const entry = {
      shareId: "share-1",
      fileId: "dcb2e1f9-3a1b-41fe-a58b-c2e0f073c4bb",
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      fingerprint: await fingerprintUploadFile(file),
      chunkSize: 8000000,
      initialChunkSize: 8000000,
      totalChunks: 1,
      cryptoChunkSize: 1000000,
      savedAt: Date.now(),
    };
    await rememberUploadResumeEntry(file, entry, key);
    assert.equal(
      [...store.values()].some(
        (value) =>
          value.includes("confidential") || value.includes("private document"),
      ),
      false,
    );
    const restored = await readUploadResumeEntries("share-1", key);
    assert.deepEqual(restored, [entry]);
    assert.deepEqual(
      await readUploadResumeEntries("share-1", await generateEncryptionKey()),
      [],
    );
    assert.deepEqual(await readUploadResumeEntries("share-2", key), []);
    const reselected = new File(["private document"], file.name, {
      lastModified: 123,
    });
    assert.deepEqual(
      await matchUploadResumeEntry(reselected, undefined, restored),
      entry,
    );
    const changed = new File(["changed document"], file.name, {
      lastModified: 123,
    });
    assert.equal(
      await matchUploadResumeEntry(changed, undefined, restored),
      undefined,
    );
    forgetUploadResumeEntry(reselected, "share-1");
    assert.equal(store.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});
async function workerFixture(
  savedParts,
  alreadyComplete = false,
  isE2E = false,
) {
  const messages = [],
    sent = [],
    read = [],
    controls = [];
  let finished;
  const completion = new Promise((resolve) => {
    finished = resolve;
  });
  const self = {
    navigator: { deviceMemory: 8, hardwareConcurrency: 8 },
    postMessage(message) {
      messages.push(message);
      if (message.type === "batch-complete" || message.type === "error")
        finished(message);
    },
  };
  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  const context = vm.createContext({
    AbortController,
    Date,
    Map,
    Set,
    Math,
    Number,
    Promise,
    Uint8Array,
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
    controls.push(parsed.pathname);
    if (parsed.pathname.endsWith("/multipart/init"))
      return json(
        alreadyComplete
          ? { id: "file", uploadComplete: true }
          : {
              id: "file",
              uploadTransport: "stream",
              uploadWindowMode: "server-adaptive-fair",
              uploadConcurrency: 2,
              uploadGlobalConcurrency: 2,
              uploadFairShare: 2,
              uploadActiveFlows: 1,
              uploadedParts: savedParts,
            },
      );
    if (parsed.pathname.endsWith("/multipart/complete"))
      return json({ id: "file", uploadComplete: true });
    sent.push(Number(parsed.searchParams.get("chunkIndex")));
    return json({
      id: "file",
      uploadTransport: "stream",
      uploadWindowMode: "server-adaptive-fair",
      uploadConcurrency: 2,
      uploadGlobalConcurrency: 2,
      uploadFairShare: 2,
      uploadActiveFlows: 1,
    });
  };
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
      shareId: "share-1",
      file: {
        size: 18000000,
        slice(from, to) {
          read.push(from);
          return { size: to - from };
        },
      },
      chunkSize: 8000000,
      initialChunkSize: 6000000,
      totalChunks: 3,
      isE2E,
      cryptoKeyRaw: isE2E ? new Uint8Array(32).buffer : undefined,
      cryptoChunkSize: 1000000,
      fileName: "file",
      startChunk: 0,
      endChunk: 3,
      serverManagedWindow: true,
    },
  });
  let timeout;
  try {
    const result = await Promise.race([
      completion,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("worker timeout")), 3000);
      }),
    ]);
    assert.equal(result.type, "batch-complete", result.message);
  } finally {
    clearTimeout(timeout);
  }
  return { sent, read, messages, controls };
}
test("multipart resume skips S3-confirmed parts without reading or retransmitting them", async () => {
  const result = await workerFixture([
    { partNumber: 1, size: 6000000 },
    { partNumber: 3, size: 4000000 },
  ]);
  assert.deepEqual(result.sent, [1]);
  assert.equal(result.read.includes(0), false);
  assert.equal(result.read.includes(14000000), false);
  assert.equal(
    result.messages.find((message) => message.type === "progress")
      .uploadedBytes,
    10000000,
  );
  assert.ok(result.controls.at(-1).endsWith("/multipart/complete"));
});
test("all confirmed parts are finalized and invalid part sizes are retransmitted", async () => {
  const all = await workerFixture([
    { partNumber: 1, size: 6000000 },
    { partNumber: 2, size: 8000000 },
    { partNumber: 3, size: 4000000 },
  ]);
  assert.equal(all.sent.length, 0);
  assert.equal(all.read.length, 0);
  assert.ok(all.controls.at(-1).endsWith("/multipart/complete"));
  const partial = await workerFixture([
    { partNumber: 1, size: 5 },
    { partNumber: 2, size: 8000000 },
  ]);
  assert.deepEqual(partial.sent.sort(), [0, 2]);
});
test("a lost completion reply never creates another multipart or retransmits a committed file", async () => {
  const result = await workerFixture([], true);
  assert.equal(result.sent.length, 0);
  assert.equal(result.read.length, 0);
  assert.equal(result.controls.length, 1);
  assert.equal(result.messages[0].uploadedBytes, 18000000);
});

test("encrypted resume validates ciphertext lengths including each record tag", async () => {
  const result = await workerFixture(
    [
      { partNumber: 1, size: 6000000 + 6 * 28 },
      { partNumber: 2, size: 8000000 + 8 * 28 },
      { partNumber: 3, size: 4000000 + 4 * 28 },
    ],
    false,
    true,
  );
  assert.equal(result.sent.length, 0);
  assert.equal(result.read.length, 0);
  assert.equal(
    result.messages.find((message) => message.type === "progress")
      .uploadedBytes,
    18000000,
  );
});
