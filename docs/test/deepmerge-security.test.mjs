import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const deepmerge = require("deepmerge");
const root = fileURLToPath(new URL("../", import.meta.url));

test("the lock installs the local deepmerge and no upstream copy", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.devDependencies.deepmerge, "file:./vendor/safe-deepmerge");
  assert.equal(manifest.overrides.deepmerge, "$deepmerge");
  assert.equal(lock.packages["node_modules/deepmerge"].link, true);
  assert.equal(
    lock.packages["node_modules/deepmerge"].resolved,
    "vendor/safe-deepmerge",
  );
  for (const [name, value] of Object.entries(lock.packages)) {
    if (name.endsWith("node_modules/deepmerge"))
      assert.ok(value.link, `${name} contains upstream deepmerge`);
  }
  const consumer = path.dirname(
    require.resolve("@svgr/plugin-svgo/package.json"),
  );
  assert.equal(
    require(require.resolve("deepmerge/package.json", { paths: [consumer] }))
      .name,
    "@privcloud/safe-deepmerge",
  );
});

test("ordinary merges keep the deepmerge 4 results", () => {
  assert.deepEqual(
    deepmerge(
      { plugins: [{ name: "preset-default" }], multipass: false },
      { plugins: [{ name: "removeTitle" }], js2svg: { indent: 2 } },
    ),
    {
      plugins: [{ name: "preset-default" }, { name: "removeTitle" }],
      multipass: false,
      js2svg: { indent: 2 },
    },
  );
  assert.deepEqual(
    deepmerge({ list: [1] }, { list: [2] }, { arrayMerge: (_t, s) => s }),
    { list: [2] },
  );
  assert.deepEqual(deepmerge.all([{ a: 1 }, { b: { c: 1 } }, { b: { d: 2 } }]), {
    a: 1,
    b: { c: 1, d: 2 },
  });
});

test("a merged __proto__ key never changes the prototype of a result", () => {
  // GHSA-gcqx-w48m-w2h4: each vector poisons the result on deepmerge 4.3.1.
  for (const [target, source] of [
    [Object.create(null), JSON.parse('{"__proto__":{"polluted":true}}')],
    [JSON.parse('{"__proto__":{"polluted":true}}'), {}],
    [{}, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}')],
    [[], JSON.parse('[{"__proto__":{"polluted":true}}]')],
  ]) {
    const result = deepmerge(target, source);
    const objects = Array.isArray(result) ? result : [result, result.nested];
    for (const value of objects.filter(Boolean)) {
      assert.equal(
        Object.getPrototypeOf(value),
        Array.isArray(value) ? Array.prototype : Object.prototype,
      );
      assert.equal(value.polluted, undefined);
      assert.equal(Object.hasOwn(value, "__proto__"), false);
    }
  }
  assert.equal({}.polluted, undefined);
});
