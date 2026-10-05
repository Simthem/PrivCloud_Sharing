import assert from "node:assert/strict";
import test from "node:test";

import { isLocalOrPrivateWebDavTarget } from "../src/services/webdav.service.ts";

test("WebDAV target classification recognizes local, private and VPN-style targets", () => {
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
