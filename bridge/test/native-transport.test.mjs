import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runNativeTransport } from "../src/native-transport.mjs";

async function fixture(run, packetBytes) {
  const input = new PassThrough(),
    output = new PassThrough();
  const pending = new Map(),
    jobs = new Map();
  const grant = randomBytes(32).toString("base64url");
  const file = randomBytes(
    packetBytes ? 2 * 1024 * 1024 + 17 : 11 * 192 * 1024,
  );
  const origin = "https://app.example.test",
    other = "https://other.example.test";
  let buffer = Buffer.alloc(0),
    writes = 0,
    upstream = 0,
    closes = 0,
    stopped = false;
  const adapter = {
    allowedOrigins: new Set([origin, other]),
    health: () => ({ name: "Companion" }),
    authorize: async (payload) => {
      if (payload.grant !== grant)
        throw Object.assign(new Error("sensitive authorization response"), {
          code: "forbidden",
          statusCode: 403,
        });
      return Date.now() + 60_000;
    },
    list: async () => {
      upstream++;
      return { entries: [] };
    },
    download: async () => {
      upstream++;
      if (packetBytes) {
        let offset = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= file.length) {
                controller.close();
                return;
              }
              controller.enqueue(file.subarray(offset, offset + packetBytes));
              offset += packetBytes;
            },
            cancel() {
              closes++;
            },
          }),
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(file);
          },
          cancel() {
            closes++;
          },
        }),
      );
    },
    createJob: () => {
      const id = randomBytes(8).toString("hex");
      const job = { id, state: "running" };
      jobs.set(id, job);
      return job;
    },
    hasJob: (id) => jobs.has(id),
    job: (id, cancel) => {
      const job = jobs.get(id);
      if (cancel) job.state = "cancelled";
      return job;
    },
    error: (error) => ({
      code: error.code || "internal_error",
      statusCode: error.statusCode || 500,
      message: "bridge.error.internal",
    }),
    shutdown: () => {
      stopped = true;
    },
  };
  output.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      assert.ok(
        length < 1024 * 1024,
        "Native replies respect Chromium's limit",
      );
      const message = JSON.parse(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
      writes++;
      const request = pending.get(message.id);
      assert.ok(request, "Every response matches exactly one request");
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message);
    }
  });
  const running = runNativeTransport(adapter, input, output);
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  };
  const request = (type, payload = {}, extra = {}, split = false) => {
    const id = randomBytes(16).toString("hex");
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native response timeout")),
        5000,
      );
      pending.set(id, { resolve, reject, timer });
    });
    const bytes = frame({ id, type, origin, payload, ...extra });
    if (split) {
      input.write(bytes.subarray(0, 2));
      input.write(bytes.subarray(2, 7));
      input.write(bytes.subarray(7));
    } else input.write(bytes);
    return promise;
  };
  try {
    await run({
      request,
      grant,
      origin,
      other,
      file,
      jobs,
      adapter,
      input,
      output,
      running,
      stats: () => ({ writes, upstream, closes, stopped }),
    });
  } finally {
    input.end();
    await running;
    output.end();
    for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}

test("native origins and authorizations are checked before contacting WebDAV", async () => {
  await fixture(async ({ request, origin, other, grant, stats }) => {
    for (const rejected of [
      undefined,
      "",
      "chrome-extension://untrusted",
      "https://attacker.invalid",
    ])
      assert.equal(
        (await request("health", {}, { origin: rejected })).error.code,
        "native_origin_denied",
      );
    assert.equal((await request("webdav.list")).error.statusCode, 401);
    const refused = await request("authorize", {
      grant: randomBytes(32).toString("base64url"),
    });
    assert.equal(refused.error.statusCode, 403);
    assert.doesNotMatch(JSON.stringify(refused), /sensitive/);
    const session = (await request("authorize", { grant })).result;
    assert.equal(
      (
        await request(
          "webdav.list",
          { sessionToken: session.token },
          { origin: other },
        )
      ).error.statusCode,
      401,
    );
    assert.equal(stats().upstream, 0);
    assert.equal((await request("health", {}, { origin })).result.paired, true);
    assert.equal(
      (await request("health", {}, { origin: other })).result.paired,
      false,
    );
  });
});

test("one persistent native port retains jobs and isolates them between sessions", async () => {
  await fixture(async ({ request, grant }) => {
    const first = (await request("authorize", { grant })).result.token;
    const second = (await request("authorize", { grant })).result.token;
    const job = (await request("webdav.upload.start", { sessionToken: first }))
      .result;
    assert.equal(
      (await request("jobs.get", { sessionToken: second, jobId: job.id })).error
        .code,
      "job_not_found",
    );
    assert.equal(
      (await request("jobs.cancel", { sessionToken: second, jobId: job.id }))
        .error.code,
      "job_not_found",
    );
    const renewed = (await request("authorize", { grant, sessionToken: first }))
      .result;
    assert.equal(renewed.token, first);
    assert.equal(
      (await request("jobs.get", { sessionToken: first, jobId: job.id })).result
        .state,
      "running",
    );
    assert.equal(
      (await request("jobs.cancel", { sessionToken: first, jobId: job.id }))
        .result.state,
      "cancelled",
    );
  });
});

test("native downloads stay bounded, preserve bytes and release readers on close", async () => {
  await fixture(async ({ request, grant, file, stats }) => {
    const first = (await request("authorize", { grant })).result.token;
    const second = (await request("authorize", { grant })).result.token;
    const opened = (
      await request("webdav.download.open", { sessionToken: first })
    ).result;
    const downloadId = opened.downloadId;
    assert.equal(
      (
        await request("webdav.download.read", {
          sessionToken: second,
          downloadId,
        })
      ).error.statusCode,
      404,
    );
    const parts = [];
    while (Buffer.concat(parts).length < file.length) {
      const response = await request("webdav.download.read", {
        sessionToken: first,
        downloadId,
      });
      assert.ok(response.result.data.length <= 256 * 1024);
      parts.push(Buffer.from(response.result.data, "base64"));
    }
    assert.deepEqual(Buffer.concat(parts), file);
    assert.equal(
      (
        await request("webdav.download.close", {
          sessionToken: first,
          downloadId,
        })
      ).result.closed,
      true,
    );
    assert.equal(stats().closes, 1);
  });
});

test("fragmented input and concurrent requests keep framing and correlation intact", async () => {
  await fixture(async ({ request, stats }) => {
    const replies = await Promise.all(
      Array.from({ length: 40 }, () => request("health", {}, {}, true)),
    );
    assert.equal(replies.length, 40);
    assert.equal(stats().writes, 40);
    assert.ok(
      replies.every(
        (reply) => reply.ok && reply.result.nativeTransportVersion === 1,
      ),
    );
  });
});

test("oversized native replies become safe errors instead of closing Chrome's port", async () => {
  await fixture(async ({ request, grant, adapter }) => {
    const session = (await request("authorize", { grant })).result;
    adapter.list = async () => ({ entries: ["x".repeat(1024 * 1024)] });
    assert.equal(
      (await request("webdav.list", { sessionToken: session.token })).error
        .code,
      "message_too_large",
    );
    assert.equal((await request("health")).ok, true);
  });
});

test("closing the native port aborts pending upstream requests", async () => {
  await fixture(async ({ request, grant, adapter, input, running, stats }) => {
    const session = (await request("authorize", { grant })).result;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    adapter.list = async (_payload, signal) => {
      entered();
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    };
    const response = request("webdav.list", { sessionToken: session.token });
    await started;
    input.end();
    await running;
    assert.equal((await response).ok, false);
    assert.equal(stats().stopped, true);
  });
});

test("small WebDAV packets fill native frames without losing the final bytes", async () => {
  await fixture(async ({ request, grant, file }) => {
    const token = (await request("authorize", { grant })).result.token;
    const { downloadId, chunkSize } = (
      await request("webdav.download.open", { sessionToken: token })
    ).result;
    const received = [];
    let done = false;
    while (!done) {
      const reply = await request("webdav.download.read", {
        sessionToken: token,
        downloadId,
      });
      assert.equal(reply.ok, true);
      done = reply.result.done;
      const bytes = Buffer.from(reply.result.data, "base64");
      assert.ok(bytes.length <= chunkSize);
      if (!done) assert.equal(bytes.length, chunkSize);
      received.push(bytes);
    }
    assert.deepEqual(Buffer.concat(received), file);
    assert.equal(received.length, Math.ceil(file.length / chunkSize));
    assert.equal(
      (
        await request("webdav.download.read", {
          sessionToken: token,
          downloadId,
        })
      ).error.statusCode,
      404,
    );
  }, 4096);
});
