import assert from "node:assert/strict";
import test from "node:test";

import {
  isLocalOrPrivateWebDavTarget,
  listWebDavViaProxy,
} from "../src/services/webdav.service.ts";

test("only local, private and VPN-style WebDAV targets require Companion", () => {
  assert.equal(
    isLocalOrPrivateWebDavTarget("https://cloud.example.test/remote.php/dav/"),
    false,
  );
  assert.equal(
    isLocalOrPrivateWebDavTarget("https://nextcloud.local/remote.php/dav/"),
    true,
  );
  assert.equal(isLocalOrPrivateWebDavTarget("https://192.168.1.8/dav/"), true);
  assert.equal(isLocalOrPrivateWebDavTarget("https://10.4.0.2/dav/"), true);
  assert.equal(isLocalOrPrivateWebDavTarget("https://[fd00::42]/dav/"), true);
});

test("the public WebDAV proxy path authenticates with the app session, not Companion", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, init) => {
    call = { url: String(url), init };
    return new Response(JSON.stringify({ error: "auth", status: 401 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      listWebDavViaProxy({
        endpoint: "https://cloud.example.test/dav/",
        username: "alice",
        password: "app-password",
      }),
      /webdav\.error\.auth/,
    );
    assert.equal(call.url, "/api/webdav/list");
    assert.equal(call.init.credentials, "include");
    assert.equal(new Headers(call.init.headers).has("Authorization"), false);
    assert.deepEqual(JSON.parse(call.init.body), {
      endpoint: "https://cloud.example.test/dav/",
      username: "alice",
      password: "app-password",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
