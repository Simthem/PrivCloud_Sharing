import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildIntegrations } from "../scripts/build.mjs";

test("integration packaging is versioned, instance-bound and Android-free", async (t) => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "privcloud-integrations-package-"),
  );
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { manifest } = await buildIntegrations({
    baseUrl: "https://oss.example.test",
    outputDirectory,
  });
  assert.equal(manifest.version, "1.24.0");
  assert.equal(manifest.baseUrl, "https://oss.example.test");
  assert.equal(manifest.artifacts.length, 5);

  for (const descriptor of manifest.artifacts) {
    const archive = await readFile(path.join(outputDirectory, descriptor.name));
    assert.equal(archive.subarray(0, 4).toString("hex"), "504b0304");
    assert.equal(
      createHash("sha256").update(archive).digest("hex"),
      descriptor.sha256,
    );
    const storedContent = archive.toString("utf8");
    assert.doesNotMatch(storedContent, /share\.example\.com/);
    assert.doesNotMatch(
      storedContent,
      /AndroidManifest|capacitor|gradle|\.apk\b/i,
    );
  }

  const browser = await readFile(
    path.join(
      outputDirectory,
      `privcloud-browser-extension-${manifest.version}.zip`,
    ),
  );
  assert.match(browser.toString("utf8"), /https:\/\/oss\.example\.test/);
  assert.match(browser.toString("utf8"), /"version": "1\.24\.0"/);
});

test("integration packaging refuses an unsafe deployment URL", async () => {
  await assert.rejects(
    buildIntegrations({
      baseUrl: "http://public.example.test/path",
      outputDirectory: path.join(os.tmpdir(), "must-not-be-created"),
    }),
    /HTTPS|origin/,
  );
});
