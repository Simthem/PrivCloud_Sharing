import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { androidBridgeFetch } from "../src/services/bridgeAndroidLoopback.service.ts";

async function fixture(run, { platform = "Android", state = "granted" } = {}) {
  const originals = new Map(
    ["navigator", "window", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const calls = [],
    token = randomBytes(32).toString("base64url");
  const control = { calls, token, state };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: platform,
      permissions: { query: async () => ({ state: control.state }) },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { isSecureContext: true },
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}");
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

test("desktop cannot invoke the Android HTTP transport", async () => {
  await fixture(
    async ({ calls }) => {
      await assert.rejects(
        androidBridgeFetch("/health", { requestAccess: true }),
        { message: "bridge.error.unavailable" },
      );
      assert.deepEqual(calls, []);
    },
    { platform: "Linux" },
  );
});

test("Android local permission denial and pending passive requests create no traffic", async () => {
  await fixture(
    async (control) => {
      await assert.rejects(
        androidBridgeFetch("/health", { requestAccess: true }),
        { message: "bridge.error.localNetworkPermissionDenied" },
      );
      control.state = "prompt";
      await assert.rejects(androidBridgeFetch("/health"), {
        message: "bridge.error.localNetworkPermissionRequired",
      });
      assert.deepEqual(control.calls, []);
    },
    { state: "denied" },
  );
});

test("the Android APK stays accessible with literal loopback, no cookies and a bearer", async () => {
  await fixture(async ({ calls, token }) => {
    await androidBridgeFetch("/webdav/list", {
      token,
      body: {
        endpoint: "https://cloud.example.test/dav/",
        username: "user",
        password: randomBytes(24).toString("base64url"),
      },
    });
    assert.equal(calls[0].url, "http://127.0.0.1:47631/v1/webdav/list");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.headers.Authorization, "Bearer " + token);
  });
});

test("Android cancellation remains attached after the response headers arrive", async () => {
  await fixture(async ({ calls }) => {
    const controller = new AbortController();
    await androidBridgeFetch("/webdav/download", { signal: controller.signal });
    assert.equal(calls[0].init.signal.aborted, false);
    controller.abort();
    assert.equal(calls[0].init.signal.aborted, true);
  });
});
