import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { buildCompanionRelease } from "../scripts/build-release.mjs";

test("the Companion release script generates a versioned verified package", async (t) => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "privcloud-companion-package-"),
  );
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { manifest } = await buildCompanionRelease({ outputDirectory });
  assert.equal(manifest.version, "1.24.0");
  assert.equal(manifest.artifacts.length, 1);

  const descriptor = manifest.artifacts[0];
  assert.equal(descriptor.name, "privcloud-companion-1.24.0.tgz");
  const artifact = await readFile(path.join(outputDirectory, descriptor.name));
  assert.equal(
    createHash("sha256").update(artifact).digest("hex"),
    descriptor.sha256,
  );

  const tar = gunzipSync(artifact).toString("utf8");
  for (const entry of [
    "package/src/privcloud-bridge.mjs",
    "package/install/install-linux-dev.sh",
    "package/native-messaging/chrome/fr.privcloud.companion.json.template",
    "package/README.md",
  ]) {
    assert.match(tar, new RegExp(entry.replaceAll(".", "\\.")));
  }

  const secondDirectory = await mkdtemp(
    path.join(os.tmpdir(), "privcloud-companion-package-repeat-"),
  );
  t.after(() => rm(secondDirectory, { recursive: true, force: true }));
  const second = await buildCompanionRelease({
    outputDirectory: secondDirectory,
  });
  assert.equal(second.manifest.artifacts[0].sha256, descriptor.sha256);
});
