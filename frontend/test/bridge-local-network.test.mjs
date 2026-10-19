import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  getBridgeHealth,
  listWebDavDirectoryViaBridge,
  downloadWebDavFileViaBridge,
  getBridgeUploadJob,
  startBridgeWebDavUploadJob,
  waitForBridgeUploadJob,
} from "../src/services/privcloudBridge.service.ts";
import { requestCompanionCommand } from "../src/services/privcloudCompanion.service.ts";

async function fixture(
  run,
  { installed = true, secure = true, protocol = 1 } = {},
) {
  const originals = new Map(
    ["window", "navigator", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const target = new EventTarget();
  const session = {
    token: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 600_000,
  };
  const storage = new Map([
    ["privcloud_native_session_v1", JSON.stringify(session)],
  ]);
  Object.assign(target, {
    isSecureContext: secure,
    location: { origin: "https://app.example.test" },
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    localStorage: { getItem: () => "https://attacker.invalid/v1" },
  });
  const calls = [],
    network = [];
  const control = {
    calls,
    network,
    storage,
    session,
    respond: (_message) => ({
      ok: true,
      result: { name: "PrivCloud Companion", nativeTransportVersion: protocol },
    }),
  };
  target.addEventListener("privcloud-companion-request", (event) => {
    const detail = event.detail;
    calls.push(detail);
    if (!installed) return;
    const response =
      detail.type === "privcloud.companion.probe"
        ? { ok: true, result: { nativeTransportVersion: protocol } }
        : control.respond(detail);
    if (response)
      queueMicrotask(() =>
        target.dispatchEvent(
          new CustomEvent("privcloud-companion-response", {
            detail: { id: detail.id, response },
          }),
        ),
      );
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { permissions: { query: async () => ({ state: "denied" }) } },
  });
  globalThis.fetch = async (...args) => {
    network.push(args);
    throw new Error("Unexpected network request");
  };
  try {
    await run(control);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("health and authenticated commands use native messages even with loopback permission denied", async () => {
  await fixture(async ({ calls, network, session }) => {
    assert.equal(
      (await getBridgeHealth({ requestLocalAccess: true })).name,
      "PrivCloud Companion",
    );
    await listWebDavDirectoryViaBridge({
      endpoint: "https://cloud.example.test/dav/",
      username: "user",
      password: randomBytes(24).toString("base64url"),
    });
    assert.equal(calls.at(-1).payload.sessionToken, session.token);
    assert.deepEqual(network, []);
    assert.equal(
      calls.filter((call) => call.type === "privcloud.companion.probe").length,
      1,
    );
  });
});

test("an absent extension never falls back to localhost", async () => {
  await fixture(
    async ({ network }) => {
      await assert.rejects(getBridgeHealth({ requestLocalAccess: true }), {
        message: "bridge.error.extensionRequired",
      });
      assert.deepEqual(network, []);
    },
    { installed: false },
  );
});

test("old extension and host protocols require an update before WebDAV", async () => {
  await fixture(
    async ({ calls }) => {
      await assert.rejects(getBridgeHealth({ requestLocalAccess: true }), {
        message: "bridge.error.updateRequired",
      });
      assert.equal(calls.length, 1);
    },
    { protocol: 0 },
  );
  await fixture(async (control) => {
    control.respond = () => ({ ok: true, result: { name: "Old Companion" } });
    await assert.rejects(getBridgeHealth({ requestLocalAccess: true }), {
      message: "bridge.error.updateRequired",
    });
  });
});

test("an insecure context and unconfigured passive check send no messages", async () => {
  await fixture(
    async ({ calls, storage }) => {
      storage.clear();
      assert.equal(await getBridgeHealth(), null);
      await assert.rejects(getBridgeHealth({ requestLocalAccess: true }), {
        message: "bridge.error.secureContextRequired",
      });
      assert.deepEqual(calls, []);
    },
    { secure: false },
  );
});

test("native authorization errors clear the session without replaying a command", async () => {
  await fixture(async (control) => {
    control.respond = () => ({
      ok: false,
      error: { message: "bridge.error.sessionExpired" },
    });
    await assert.rejects(getBridgeUploadJob("job"), {
      message: "bridge.error.sessionExpired",
    });
    assert.equal(control.storage.size, 0);
    assert.equal(
      control.calls.filter(
        (call) => call.type === "privcloud.companion.jobs.get",
      ).length,
      1,
    );
  });
});

test("native error details cannot expose credentials or remote response markup", async () => {
  await fixture(async (control) => {
    control.respond = () => ({
      ok: false,
      error: { message: "<script>secret remote response</script>" },
    });
    await assert.rejects(getBridgeUploadJob("job"), {
      message: "bridge.error.unavailable",
    });
  });
});

test("downloads reconstruct bounded chunks and close their reader on cancellation", async () => {
  await fixture(async (control) => {
    const bytes = randomBytes(512_007),
      parts = [];
    for (let offset = 0; offset < bytes.length; offset += 192 * 1024)
      parts.push(
        bytes.subarray(offset, offset + 192 * 1024).toString("base64"),
      );
    control.respond = ({ type }) => ({
      ok: true,
      result: type.endsWith(".open")
        ? { downloadId: "download", contentType: "application/octet-stream" }
        : { data: parts.shift() ?? "", done: parts.length === 0 },
    });
    const file = await downloadWebDavFileViaBridge(
      {},
      { name: "file.bin", href: "/file.bin" },
    );
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    const controller = new AbortController();
    control.respond = ({ type }) => {
      if (type.endsWith(".open"))
        return { ok: true, result: { downloadId: "cancelled-download" } };
      if (type.endsWith(".read")) {
        controller.abort();
        return null;
      }
      return { ok: true, result: { closed: true } };
    };
    await assert.rejects(
      downloadWebDavFileViaBridge(
        {},
        { name: "cancel.bin", href: "/cancel.bin" },
        controller.signal,
      ),
      { name: "AbortError" },
    );
    assert.equal(
      control.calls.at(-1).type,
      "privcloud.companion.webdav.download.close",
    );
  });
});

test("a cancelled poll waits for the native cancel command and removes abort listeners", async () => {
  await fixture(async (control) => {
    const controller = new AbortController();
    control.respond = ({ type }) => ({
      ok: true,
      result: {
        id: "job",
        state: type.endsWith(".cancel") ? "cancelled" : "running",
      },
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      waitForBridgeUploadJob("job", {
        signal: controller.signal,
        pollIntervalMs: 1000,
      }),
      (error) => error.cancelled === true,
    );
    assert.equal(control.calls.at(-1).type, "privcloud.companion.jobs.cancel");
  });
});

test("an aborted request removes its event listener and ignores a late response", async () => {
  await fixture(async (control) => {
    control.respond = () => null;
    const controller = new AbortController();
    const request = requestCompanionCommand("health", {}, controller.signal);
    queueMicrotask(() => controller.abort());
    await assert.rejects(request, { name: "AbortError" });
  });
});

// An older Companion ignores encrypted label fields. Reject before handing it a job.
test("encrypted label jobs require a capable Companion before sending any secret", async () => {
  await fixture(async (control) => {
    const payload = {
      fileMetadataScheme: 1,
      files: [],
      encryptionKey: randomBytes(32).toString("base64url"),
    };
    control.respond = () => ({
      ok: true,
      result: {
        name: "PrivCloud Companion",
        nativeTransportVersion: 1,
        capabilities: {},
      },
    });
    await assert.rejects(startBridgeWebDavUploadJob(payload), {
      message: "bridge.error.updateRequired",
    });
    assert.ok(
      !control.calls.some((call) => call.type.endsWith("webdav.upload.start")),
    );
    assert.ok(!JSON.stringify(control.calls).includes(payload.encryptionKey));
    control.respond = ({ type }) => ({
      ok: true,
      result: type.endsWith("health")
        ? {
            name: "PrivCloud Companion",
            nativeTransportVersion: 1,
            capabilities: { fileMetadataV1: true },
          }
        : { id: "protected-job" },
    });
    assert.equal(
      (await startBridgeWebDavUploadJob(payload)).id,
      "protected-job",
    );
    assert.equal(
      control.calls.at(-1).type,
      "privcloud.companion.webdav.upload.start",
    );
  });
});
