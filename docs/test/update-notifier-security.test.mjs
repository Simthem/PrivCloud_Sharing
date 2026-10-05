import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import updateNotifier from "update-notifier";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

test("the docs update checker and its vulnerable HTTP cache are absent", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.overrides["update-notifier"], "$update-notifier");
  assert.equal(lock.packages["node_modules/update-notifier"].link, true);
  assert.equal(
    lock.packages["node_modules/update-notifier"].resolved,
    "vendor/disabled-update-notifier",
  );
  for (const name of Object.keys(lock.packages)) {
    assert.ok(
      !/\/node_modules\/(?:got|cacheable-request|http-cache-semantics)$/.test(
        "/" + name,
      ),
      name,
    );
  }
  const result = updateNotifier({
    pkg: { name: "@docusaurus/core", version: "3.10.1" },
    shouldNotifyInNpmScript: true,
  });
  assert.equal(result.disabled, true);
  assert.equal(result.config, undefined);
  assert.equal(result.update, undefined);
  assert.ok(Object.isFrozen(result));
});

test("the actual Docusaurus CLI starts with the disabled update checker", () => {
  const result = spawnSync(
    process.execPath,
    ["node_modules/@docusaurus/core/bin/docusaurus.mjs", "--version"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^3\.10\.1\s*$/);
});

test("chokidar still watches new Markdown and MDX files through brace globs", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "privcloud-docs-watch-"));
  mkdirSync(path.join(directory, "nested"));
  writeFileSync(path.join(directory, "guide.md"), "initial");
  const watcher = require("chokidar").watch(
    path.join(directory, "**/*.{md,mdx}"),
    { ignoreInitial: false },
  );
  const found = [];
  watcher.on("add", (name) => found.push(path.relative(directory, name)));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("chokidar did not become ready")),
        5_000,
      );
      watcher.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
      watcher.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.deepEqual(found, ["guide.md"]);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("chokidar did not discover MDX")),
        5_000,
      );
      watcher.on("add", (name) => {
        if (path.basename(name) === "intro.mdx") {
          clearTimeout(timeout);
          resolve();
        }
      });
      writeFileSync(path.join(directory, "nested/intro.mdx"), "new");
    });
    assert.ok(found.includes("nested/intro.mdx"));
  } finally {
    await watcher.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
