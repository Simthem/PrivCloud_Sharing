import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { uploadDirectFile, createUploadSlots, runParallelFiles } from "../src/direct-upload.mjs";

const chunkSize = 6 * 1024 * 1024;
function fixture({ encrypted = true, concurrency = 2, rejection, partSize = chunkSize } = {}) {
  const chunkSize = partSize;
  const key = randomBytes(32),
    parts = new Map();
  const fileSize = chunkSize * 4 + 19;
  let active = 0,
    peak = 0,
    consumed = 0,
    progress = 0,
    complete = false;
  const control = [];
  async function* chunks() {
    for (let offset = 0; offset < fileSize; offset += chunkSize) {
      consumed++;
      yield Buffer.alloc(Math.min(chunkSize, fileSize - offset), consumed);
    }
  }
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://app.example.test") {
      assert.equal(init.headers.Authorization, "Bearer pcbu_test-only");
      assert.equal(init.redirect, "manual");
      const body = JSON.parse(init.body);
      control.push({ path: parsed.pathname, body });
      assert.doesNotMatch(
        init.body,
        /WebDAV-secret|private-name|encryptionKey/,
      );
      if (parsed.pathname.endsWith("/init"))
        return Response.json({
          uploadTransport: "direct-s3",
          uploadConcurrency: concurrency,
        });
      if (parsed.pathname.endsWith("/part-urls"))
        return Response.json({
          parts: body.parts.map((part) => ({
            partNumber: part.chunkIndex + 1,
            contentLength: part.contentLength,
            url: `https://storage.example.test/part/${part.chunkIndex + 1}`,
          })),
        });
      if (parsed.pathname.endsWith("/complete")) {
        complete = true;
        return Response.json({ id: body.id });
      }
      throw new Error("Unexpected control endpoint");
    }
    assert.equal(parsed.origin, "https://storage.example.test");
    assert.equal(init.method, "PUT");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(Number(init.headers["Content-Length"]), init.body.length);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active--;
    init.signal.throwIfAborted();
    if (rejection) return new Response(null, { status: rejection });
    const part = Number(parsed.pathname.split("/").pop());
    let plain = init.body;
    if (encrypted) {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        plain.subarray(0, 12),
      );
      cipher.setAuthTag(plain.subarray(-16));
      plain = Buffer.concat([
        cipher.update(plain.subarray(12, -16)),
        cipher.final(),
      ]);
    }
    assert.ok(plain.every((byte) => byte === part));
    parts.set(part, plain.length);
    return new Response(null, { status: 200 });
  };
  const options = {
    appBaseUrl: "https://app.example.test",
    shareId: "share-fixture",
    uploadToken: "pcbu_test-only",
    metadata: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "encrypted-file-00000000",
      encryptedMetadata: "ciphertext",
    },
    fileSize,
    chunkSize,
    encrypted,
    chunks: chunks(),
    fetchImpl,
    transform: encrypted
      ? (plain) => {
          const iv = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key, iv);
          return Buffer.concat([
            iv,
            cipher.update(plain),
            cipher.final(),
            cipher.getAuthTag(),
          ]);
        }
      : (plain) => plain,
    onProgress: (bytes) => {
      progress += bytes;
    },
  };
  return {
    options,
    parts,
    control,
    stats: () => ({ active, peak, consumed, progress, complete, fileSize }),
  };
}

test("direct WebDAV uploads preserve ciphertext, bounded concurrency and completion", async () => {
  const { options, parts, control, stats } = fixture();
  assert.equal(await uploadDirectFile(options), true);
  assert.equal(parts.size, 5);
  assert.deepEqual(stats(), {
    active: 0,
    peak: 2,
    consumed: 5,
    progress: options.fileSize,
    complete: true,
    fileSize: options.fileSize,
  });
  assert.equal(control[0].body.encryptionChunkSize, chunkSize);
  assert.equal(control.filter((c) => c.path.endsWith("/complete")).length, 1);
});

test("relay-only and old APIs leave the source unread for the established upload", async () => {
  for (const answer of [
    new Response(null, { status: 404 }),
    Response.json({ uploadTransport: "buffered" }),
  ]) {
    const { options, stats } = fixture();
    options.fetchImpl = async () => answer;
    assert.equal(await uploadDirectFile(options), false);
    assert.equal(stats().consumed, 0);
  }
});

test("a permanent S3 rejection cancels siblings and never completes the file", async () => {
  const { options, stats } = fixture({ rejection: 400 });
  await assert.rejects(uploadDirectFile(options), /HTTP 400/);
  assert.equal(stats().complete, false);
  assert.ok(stats().consumed <= 2);
  assert.equal(stats().active, 0);
});

test("expired authorizations are refreshed without counting retries twice", async () => {
  const { options, stats } = fixture({ encrypted: false, concurrency: 1 });
  const original = options.fetchImpl;
  let expired = false,
    authorizations = 0;
  options.fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith("/part-urls")) authorizations++;
    if (new URL(url).origin === "https://storage.example.test" && !expired) {
      expired = true;
      return new Response(null, { status: 403 });
    }
    return original(url, init);
  };
  await uploadDirectFile(options);
  assert.equal(authorizations, 6);
  assert.equal(stats().progress, options.fileSize);
  assert.equal(stats().peak, 1);
});

test("abort and incorrect source length cannot finalize a multipart file", async () => {
  for (const aborted of [true, false]) {
    const { options, stats } = fixture();
    if (aborted) {
      const controller = new AbortController();
      controller.abort();
      options.signal = controller.signal;
    } else
      options.chunks = (async function* () {
        yield Buffer.alloc(11);
      })();
    await assert.rejects(uploadDirectFile(options));
    assert.equal(stats().complete, false);
  }
});

test("small nonempty files also bypass the API data plane", async () => {
  const { options, parts, stats } = fixture();
  options.fileSize = 19;
  options.chunks = (async function* () {
    yield Buffer.alloc(19, 1);
  })();
  assert.equal(await uploadDirectFile(options), true);
  assert.equal(parts.get(1), 19);
  assert.equal(stats().progress, 19);
  assert.equal(stats().complete, true);
});

test("multiple tabs queue managed uploads and cancellation removes waiters", async () => {
  const acquire = createUploadSlots(2);
  const first = await acquire(new AbortController().signal);
  const second = await acquire(new AbortController().signal);
  const cancelled = new AbortController();
  const waiting = acquire(cancelled.signal);
  cancelled.abort();
  await assert.rejects(waiting);
  let thirdStarted = false;
  const third = acquire(new AbortController().signal).then((release) => {
    thirdStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  first();
  const releaseThird = await third;
  assert.equal(thirdStarted, true);
  first(); // Releasing twice cannot manufacture capacity.
  let fourthStarted = false;
  const fourth = acquire(new AbortController().signal).then((release) => {
    fourthStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(fourthStarted, false);
  second();
  (await fourth)();
  releaseThird();
});

test("one file can overlap four encrypted S3 parts when authorized", async () => {
  const { options, stats } = fixture({ concurrency: 8 });
  await uploadDirectFile(options);
  assert.equal(stats().peak, 4);
  assert.equal(stats().progress, options.fileSize);
});

test("S3 part capacity is shared across concurrent files", async () => {
  const first = fixture({ concurrency: 4 });
  const second = fixture({ concurrency: 4 });
  let active = 0;
  let peak = 0;
  for (const { options } of [first, second]) {
    const original = options.fetchImpl;
    options.fetchImpl = async (url, init) => {
      if (new URL(url).origin !== "https://storage.example.test") return original(url, init);
      active++;
      peak = Math.max(peak, active);
      try { return await original(url, init); }
      finally { active--; }
    };
  }
  await Promise.all([uploadDirectFile(first.options), uploadDirectFile(second.options)]);
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(first.stats().complete, true);
  assert.equal(second.stats().complete, true);
});

test("a multi-file job overlaps two files and waits for both before finishing", async () => {
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const completed = [];
  await runParallelFiles(5, async (index) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(index);
    active--;
  }, controller);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4]);
});

test("a failed file aborts siblings, stops queued files and preserves the cause", async () => {
  const controller = new AbortController();
  const failure = new Error("S3 rejected the first file");
  const started = [];
  let drained = false;
  await assert.rejects(runParallelFiles(5, async (index) => {
    started.push(index);
    if (index === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw failure;
    }
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    drained = true;
    throw controller.signal.reason;
  }, controller), (error) => error === failure);
  assert.deepEqual(started, [0, 1]);
  assert.equal(drained, true);
});

test("larger records reduce parallel parts to preserve the working buffer budget", async () => {
  const { options, stats } = fixture({ concurrency: 8, partSize: 16 * 1024 * 1024 });
  await uploadDirectFile(options);
  assert.equal(stats().peak, 2);
  assert.equal(stats().progress, options.fileSize);
});
