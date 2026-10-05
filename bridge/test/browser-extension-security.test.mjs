import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(
  new URL(
    "../../integrations/browser-extension/src/background.js",
    import.meta.url,
  ),
  "utf8",
);

function fixture() {
  const origin = "https://app.example.test";
  const messages = [],
    tabs = [],
    ports = [];
  let listener,
    reply = true;
  const api = {
    runtime: {
      id: "fixture-extension",
      lastError: undefined,
      getURL: (path) => "chrome-extension://fixture-extension/" + path,
      getManifest: () => ({
        version: "1.25.2",
        content_scripts: [{ matches: [origin + "/*"] }],
      }),
      onMessage: {
        addListener: (callback) => {
          listener = callback;
        },
      },
      connectNative: () => {
        let receive, disconnect;
        const port = {
          onMessage: {
            addListener: (callback) => {
              receive = callback;
            },
          },
          onDisconnect: {
            addListener: (callback) => {
              disconnect = callback;
            },
          },
          postMessage: (message) => {
            messages.push(message);
            if (reply)
              queueMicrotask(() =>
                receive({
                  id: message.id,
                  ok: true,
                  result: { origin: message.origin },
                }),
              );
          },
          disconnect: () => disconnect(),
        };
        ports.push(port);
        return port;
      },
    },
    tabs: {
      create: async (tab) => {
        tabs.push(tab);
      },
    },
  };
  vm.runInNewContext(
    source.replace(
      /const DEFAULT_APP_URL = "[^"]+";/,
      `const DEFAULT_APP_URL = ${JSON.stringify(origin)};`,
    ),
    { chrome: api, URL, TextEncoder, crypto, setTimeout, clearTimeout },
  );
  const sender = {
    id: api.runtime.id,
    origin,
    url: origin + "/upload",
    frameId: 0,
    tab: { id: 1 },
  };
  const request = (message, customSender = sender) =>
    new Promise((resolve) => listener(message, customSender, resolve));
  return {
    request,
    messages,
    ports,
    sender,
    origin,
    tabs,
    disableReplies: () => {
      reply = false;
    },
  };
}

test("the extension derives native origins from Chromium's sender and reuses its port", async () => {
  const control = fixture();
  const first = await control.request({
    type: "privcloud.companion.health",
    origin: "https://attacker.invalid",
    payload: {},
  });
  assert.equal(first.result.origin, control.origin);
  await control.request({ type: "privcloud.companion.health", payload: {} });
  assert.equal(control.ports.length, 1);
  assert.ok(
    control.messages.every((message) => message.origin === control.origin),
  );
  control.ports[0].disconnect();
});

test("foreign senders, frames, opaque origins and unlisted sites cannot reach the native host", async () => {
  const control = fixture();
  for (const changed of [
    { id: "other-extension" },
    { frameId: 1 },
    { origin: "null" },
    {
      origin: "https://attacker.invalid",
      url: "https://attacker.invalid/upload",
    },
    { url: "https://attacker.invalid/upload" },
  ]) {
    const response = await control.request(
      { type: "privcloud.companion.authorize", origin: control.origin },
      { ...control.sender, ...changed },
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.message, "bridge.error.originDenied");
  }
  assert.equal(control.ports.length, 0);
});

test("only known bounded commands are forwarded; the popup has health access only", async () => {
  const control = fixture();
  const probe = await control.request({ type: "privcloud.companion.probe" });
  assert.equal(probe.result.nativeTransportVersion, 1);
  assert.equal(control.ports.length, 0);
  assert.equal(
    (await control.request({ type: "privcloud.companion.shell" })).ok,
    false,
  );
  assert.equal(
    (
      await control.request({
        type: "privcloud.companion.health",
        payload: { value: "x".repeat(256 * 1024) },
      })
    ).error.message,
    "bridge.error.messageTooLarge",
  );
  const popup = {
    id: control.sender.id,
    url: "chrome-extension://fixture-extension/src/popup.html",
  };
  assert.equal(
    (await control.request({ type: "privcloud.companion.authorize" }, popup))
      .ok,
    false,
  );
  assert.equal(
    (await control.request({ type: "privcloud.companion.health" }, popup)).ok,
    true,
  );
  control.ports[0].disconnect();
});

test("disconnect rejects pending commands and never retries through HTTP", async () => {
  const control = fixture();
  control.disableReplies();
  const response = control.request({
    type: "privcloud.companion.webdav.upload.start",
    payload: {},
  });
  control.ports[0].disconnect();
  assert.equal((await response).error.message, "bridge.error.unavailable");
  assert.equal(control.messages.length, 1);
});

test("open commands cannot redirect users to another origin", async () => {
  const control = fixture();
  for (const path of [
    "//attacker.invalid/",
    "https://attacker.invalid/",
    "javascript:alert(1)",
  ])
    assert.equal(
      (await control.request({ type: "privcloud.open", payload: { path } })).ok,
      false,
    );
  assert.equal(
    (
      await control.request({
        type: "privcloud.open",
        payload: { path: "/upload?source=gmail" },
      })
    ).ok,
    true,
  );
  assert.equal(control.tabs[0].url, control.origin + "/upload?source=gmail");
});
