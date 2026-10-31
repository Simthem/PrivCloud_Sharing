import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

// GHSA-g3hv-75wg-m249 (minimatch < 11.0.1), GHSA-3g3m-2fjr-6pw4
// (glob 9.0.0 to 14.0.1), GHSA-4528-x5fx-h6hg (joi 17.1.1 to 17.13.8 and
// 18.0.0 to 18.3.0) and GHSA-mrwp-f3q8-3g9p (follow-redirects 1.16.0 and
// 1.16.1). A version below the first line of a family is not affected.
const advisories = {
  minimatch: [["0.0.0", "11.0.1"]],
  glob: [["9.0.0", "14.0.2"]],
  joi: [
    ["17.1.1", "17.13.9"],
    ["18.0.0", "18.3.1"],
  ],
  "follow-redirects": [["1.16.0", "1.16.2"]],
};

function compare(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a.map((part, index) => part - b[index]).find((part) => part !== 0) ?? 0;
}

function isAffected(name, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${name}@${version}`);
  return advisories[name].some(
    ([first, fixed]) => compare(version, first) >= 0 && compare(version, fixed) < 0,
  );
}

function scope(name) {
  const manifestUrl = new URL(`../../${name}/package.json`, import.meta.url);
  return {
    manifest: JSON.parse(readFileSync(manifestUrl, "utf8")),
    lock: JSON.parse(readFileSync(new URL("./package-lock.json", manifestUrl), "utf8")),
  };
}

test("frontend, backend and docs locks hold no copy affected by the October 30 advisories", () => {
  for (const name of ["frontend", "backend", "docs"]) {
    const { lock } = scope(name);
    for (const [path, pkg] of Object.entries(lock.packages)) {
      const family = path.match(/(?:^|\/)node_modules\/([^/]+)$/)?.[1];
      if (!family || !advisories[family]) continue;
      assert.equal(isAffected(family, pkg.version), false, `${name}/${path}: ${pkg.version}`);
    }
  }
});

test("the overrides force the fixed minimatch, glob and joi releases", () => {
  const backend = scope("backend").manifest.overrides;
  const docs = scope("docs").manifest.overrides;
  const frontend = scope("frontend").manifest.overrides;
  assert.equal(backend.minimatch, "11.0.3");
  assert.equal(backend.glob, "14.0.3");
  assert.equal(backend.joi, "18.3.1");
  assert.equal(docs.minimatch, "11.0.3");
  assert.equal(docs.joi, "17.13.9");
  assert.match(docs["follow-redirects"], /^(>=)?1\.16\.2$/);
  assert.equal(frontend.minimatch, "11.0.3");
});

test("the installed frontend minimatch is the locked fixed release", () => {
  const { lock } = scope("frontend");
  const installed = require("minimatch/package.json").version;
  assert.equal(installed, lock.packages["node_modules/minimatch"].version);
  assert.equal(isAffected("minimatch", installed), false);
  const { minimatch } = require("minimatch");
  assert.equal(minimatch("src/pages/index.tsx", "src/**/*.{ts,tsx}"), true);
  assert.equal(minimatch(".env", "*"), false);
});
