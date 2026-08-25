import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeUnavailableError,
  isOpenSourceBridgeCompatible,
  listWebDavDirectoryViaBridge,
} from "../src/services/privcloudBridge.service.ts";

test("only the open-source Companion authorization contract is accepted", () => {
  const baseHealth = {
    name: "PrivCloud Companion",
    version: "1.24.0",
    bridgeId: "test",
    paired: false,
    capabilities: {
      webdav: true,
      directBrowserImport: true,
      managedEncryptedUpload: true,
      localTokenAuthorization: true,
    },
  };

  assert.equal(isOpenSourceBridgeCompatible(baseHealth), false);
  assert.equal(
    isOpenSourceBridgeCompatible({
      ...baseHealth,
      capabilities: {
        ...baseHealth.capabilities,
        openSourceLocalAuthorization: true,
      },
    }),
    true,
  );
  assert.equal(isOpenSourceBridgeCompatible(null), false);
});

test("Bridge failures stay local and report the Companion as unavailable", async () => {
  const hadWindow = Object.hasOwn(globalThis, "window");
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new Map([
    ["privcloud_bridge_token", "local-secret-token"],
    ["privcloud_bridge_base_url", "https://attacker.invalid/v1"],
  ]);
  const calls = [];

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    },
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    throw new TypeError("connection refused");
  };

  try {
    await assert.rejects(
      listWebDavDirectoryViaBridge(
        {
          endpoint: "https://cloud.example.test/dav/",
          username: "alice",
          password: "app-password",
        },
        "/dav/files/alice/",
      ),
      (error) =>
        error instanceof BridgeUnavailableError &&
        error.message === "bridge.error.unavailable",
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ url }) => new URL(url).hostname),
      ["127.0.0.1", "localhost"],
    );
    assert.equal(
      calls.some(({ url }) => url.startsWith("https://attacker.invalid")),
      false,
    );
    assert.equal(
      calls.every(
        ({ init }) =>
          new Headers(init.headers).get("Authorization") ===
          "Bearer local-secret-token",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    } else {
      delete globalThis.window;
    }
  }
});
