import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "privcloud-package-runtime-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const payload = path.join(directory, "payload");
  const bin = path.join(directory, "system-bin");
  await mkdir(home);
  await mkdir(payload);
  await mkdir(bin);
  const launcher = path.join(payload, "privcloud-companion");
  await copyFile(
    path.join(root, "bridge/install/linux/privcloud-companion.sh"),
    launcher,
  );
  await chmod(launcher, 0o755);
  await copyFile(
    path.join(root, "bridge/src/privcloud-bridge.mjs"),
    path.join(payload, "privcloud-companion.mjs"),
  );
  await copyFile(
    path.join(root, "bridge/src/native-transport.mjs"),
    path.join(payload, "native-transport.mjs"),
  );
  await copyFile(
    path.join(root, "bridge/src/direct-upload.mjs"),
    path.join(payload, "direct-upload.mjs"),
  );
  const obsolete = path.join(bin, "node");
  await writeFile(
    obsolete,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v19.9.0; exit 0; fi\nexit 1\n',
  );
  await chmod(obsolete, 0o755);
  const nvmNode = path.join(
    home,
    ".nvm/versions/node/current with spaces/bin/node",
  );
  await mkdir(path.dirname(nvmNode), { recursive: true });
  await symlink(process.execPath, nvmNode);
  const preload = path.join(directory, "noisy-preload.cjs");
  await writeFile(
    preload,
    'process.stdout.write("unexpected instrumentation\\n");',
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin + ":/usr/bin:/bin",
    NODE_OPTIONS: `--require=${preload}`,
    PRIVCLOUD_BRIDGE_STATE_DIR: path.join(directory, "state"),
  };
  const run = (args, input) =>
    spawnSync(launcher, args, { env, input, timeout: 5000 });
  return { directory, home, launcher, env, run, nvmNode, obsolete };
}

function healthFrame() {
  const body = Buffer.from(
    JSON.stringify({
      id: "package-health",
      type: "health",
      origin: "http://localhost:3000",
      payload: {},
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test("packaged launcher rejects Node 19 and keeps native stdout empty", async (t) => {
  const { run, obsolete } = await fixture(t);
  for (const args of [
    ["--native-messaging"],
    ["--configure-runtime", obsolete],
  ]) {
    const result = run(args, healthFrame());
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr.toString(), /Node\.js 20/);
  }
});

test("NVM configuration survives the browser PATH and clears native instrumentation", async (t) => {
  const { run, home, nvmNode } = await fixture(t);
  const configured = run(["--configure-runtime", nvmNode]);
  assert.equal(configured.status, 0, configured.stderr.toString());
  assert.equal(configured.stdout.length, 0);
  const config = path.join(home, ".config/privcloud-companion/node-path");
  assert.equal(await readFile(config, "utf8"), nvmNode + "\n");
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  const native = run(
    ["chrome-extension://" + "a".repeat(32) + "/"],
    healthFrame(),
  );
  assert.equal(native.status, 0, native.stderr.toString());
  assert.ok(native.stdout.length > 4);
  assert.equal(native.stdout.readUInt32LE(0), native.stdout.length - 4);
  const response = JSON.parse(native.stdout.subarray(4));
  assert.equal(response.ok, true);
  assert.equal(response.result.nativeTransportVersion, 1);
  await rm(nvmNode);
  const removed = run(["--native-messaging"], healthFrame());
  assert.notEqual(removed.status, 0);
  assert.equal(removed.stdout.length, 0);
  assert.match(removed.stderr.toString(), /configure-runtime/);
});

test("native registration uses the actual portable launcher and Flatpak profile", async (t) => {
  const { home, launcher, env } = await fixture(t);
  const helper = path.join(
    path.dirname(launcher),
    "register-native-messaging.sh",
  );
  await copyFile(
    path.join(root, "bridge/install/linux/register-native-messaging.sh"),
    helper,
  );
  await mkdir(path.join(home, ".var/app/org.chromium.Chromium"), {
    recursive: true,
  });
  const extensionId = "a".repeat(32);
  const result = spawnSync("sh", [helper], {
    env: {
      ...env,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PRIVCLOUD_CHROME_EXTENSION_ID: extensionId,
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const directory of [
    ".config/chromium",
    ".config/google-chrome",
    ".var/app/org.chromium.Chromium/config/chromium",
  ]) {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          home,
          directory,
          "NativeMessagingHosts/fr.privcloud.companion.json",
        ),
      ),
    );
    assert.equal(manifest.path, launcher);
    assert.deepEqual(manifest.allowed_origins, [
      `chrome-extension://${extensionId}/`,
    ]);
  }
  const invalid = spawnSync("sh", [helper], {
    env: { ...env, PRIVCLOUD_COMPANION_PATH: launcher + '"' },
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unsupported JSON/);
});
