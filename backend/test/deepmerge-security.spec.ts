import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import deepmerge from "deepmerge";

const loadPackage = createRequire(__filename);
const root = path.resolve(__dirname, "..");

// GHSA-gcqx-w48m-w2h4: each vector changes the prototype of the result on
// deepmerge 4.3.1, the latest upstream release.
const POISONING_VECTORS: Array<[unknown, unknown]> = [
  [Object.create(null), JSON.parse('{"__proto__":{"polluted":true}}')],
  [JSON.parse('{"__proto__":{"polluted":true}}'), {}],
  [{}, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}')],
  [[], JSON.parse('[{"__proto__":{"polluted":true}}]')],
];

function readJson(filename: string) {
  return JSON.parse(readFileSync(path.join(root, filename), "utf8"));
}

test("the lock installs the local deepmerge and no upstream copy", () => {
  const manifest = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(
    manifest.devDependencies.deepmerge,
    "file:./vendor/safe-deepmerge",
  );
  assert.equal(manifest.overrides.deepmerge, "$deepmerge");
  assert.equal(lock.packages["node_modules/deepmerge"].link, true);
  assert.equal(
    lock.packages["node_modules/deepmerge"].resolved,
    "vendor/safe-deepmerge",
  );
  for (const [name, entry] of Object.entries<{ link?: boolean }>(
    lock.packages,
  )) {
    if (name.endsWith("node_modules/deepmerge"))
      assert.ok(entry.link, `${name} contains upstream deepmerge`);
  }
  const consumer = path.dirname(
    loadPackage.resolve("fork-ts-checker-webpack-plugin/package.json"),
  );
  const installed = loadPackage.resolve("deepmerge/package.json", {
    paths: [consumer],
  });
  assert.equal(
    JSON.parse(readFileSync(installed, "utf8")).name,
    "@privcloud/safe-deepmerge",
  );
});

test("ordinary merges keep the deepmerge 4 results", () => {
  assert.deepEqual(
    deepmerge(
      { async: false, typescript: { memoryLimit: 2048, mode: "readonly" } },
      {
        typescript: { memoryLimit: 4096 },
        issue: { include: [{ file: "a" }] },
      },
    ),
    {
      async: false,
      typescript: { memoryLimit: 4096, mode: "readonly" },
      issue: { include: [{ file: "a" }] },
    },
  );
  assert.deepEqual(deepmerge({ list: [1] }, { list: [2] }), { list: [1, 2] });
  assert.deepEqual(
    deepmerge({ list: [1] }, { list: [2] }, { arrayMerge: (_t, s) => s }),
    { list: [2] },
  );
  assert.deepEqual(deepmerge({ a: [1] }, { a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(
    deepmerge.all([{ a: 1 }, { b: { c: 1 } }, { b: { d: 2 } }]),
    { a: 1, b: { c: 1, d: 2 } },
  );
  const options = {};
  deepmerge({ a: 1 }, { b: 2 }, options);
  assert.deepEqual(options, {});
});

test("a merged __proto__ key never changes the prototype of a result", () => {
  for (const [target, source] of POISONING_VECTORS) {
    const result = deepmerge(target, source);
    const objects = Array.isArray(result) ? result : [result, result.nested];
    for (const value of objects.filter(Boolean)) {
      assert.equal(
        Object.getPrototypeOf(value),
        Array.isArray(value) ? Array.prototype : Object.prototype,
      );
      assert.equal(value.polluted, undefined);
      assert.equal(
        Object.prototype.hasOwnProperty.call(value, "__proto__"),
        false,
      );
    }
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
