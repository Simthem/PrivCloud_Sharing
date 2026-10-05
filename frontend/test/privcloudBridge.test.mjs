import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { listWebDavDirectoryViaBridge } from "../src/services/privcloudBridge.service.ts";

test("legacy bearer tokens and attacker-controlled base URLs cannot cause a fallback or exfiltration", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const calls = [];
  const storage = new Map([
    ["privcloud_bridge_token", randomBytes(32).toString("base64url")],
    ["privcloud_bridge_base_url", "https://attacker.invalid/v1"],
  ]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: (key) => storage.get(key) ?? null },
      sessionStorage: { getItem: () => null },
    },
  });
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("Unexpected network request");
  };
  try {
    await assert.rejects(
      listWebDavDirectoryViaBridge({
        endpoint: "https://cloud.example.test/dav/",
        username: "user",
        password: randomBytes(24).toString("base64url"),
      }),
      { message: "bridge.error.sessionExpired" },
    );
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  }
});
