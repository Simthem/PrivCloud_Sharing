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

const require = createRequire(import.meta.url);
const braces = require("braces");
const root = fileURLToPath(new URL("../", import.meta.url));

test("the lock installs the bounded implementation and excludes upstream braces", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.overrides.braces, "$braces");
  assert.equal(
    require("braces/package.json").name,
    "@privcloud/brace-patterns",
  );
  assert.equal(lock.packages["node_modules/braces"].link, true);
  assert.equal(
    lock.packages["node_modules/braces"].resolved,
    "vendor/brace-patterns",
  );
  for (const [name, value] of Object.entries(lock.packages)) {
    if (name.endsWith("/braces"))
      assert.ok(value.link, `${name} contains upstream braces`);
    assert.ok(
      !name.includes("node_modules/micromatch/vendor/"),
      "local dependency path must be portable",
    );
  }
});

test("ordinary glob patterns retain their compile and expansion behavior", () => {
  for (const [pattern, compiled, expanded] of [
    ["src/**/*.{ts,tsx}", "src/**/*.(ts|tsx)", ["src/**/*.ts", "src/**/*.tsx"]],
    [
      "a/{b,{c,d}}/*.js",
      "a/(b|(c|d))/*.js",
      ["a/b/*.js", "a/c/*.js", "a/d/*.js"],
    ],
    ["{01..03}", "(0[1-3])", ["01", "02", "03"]],
    ["{a..g..2}", "(a|c|e|g)", ["a", "c", "e", "g"]],
    ["{a,,b}", "(a|b)", ["a", "", "b"]],
    ["{a,b,}", "(a|b|)", ["a", "b", ""]],
    ["foo\\{a,b\\}", "foo{a,b}", ["foo{a,b}"]],
    ["a[{b,c}]", "a[{b,c}]", ["a[{b,c}]"]],
    ['foo/"{a,b}"', "foo/{a,b}", ["foo/{a,b}"]],
    ["${a,{b,c}}", "${a,{b,c}}", ["${a,{b,c}}"]],
    ["{a{b,c}}", "{a(b|c)}", ["{ab}", "{ac}"]],
    ["{a,{b,c}", "{a,(b|c)", ["{a,b", "{a,c"]],
  ]) {
    assert.deepEqual(braces(pattern), [compiled], pattern);
    assert.deepEqual(braces.expand(pattern), expanded, pattern);
  }
  assert.deepEqual(
    braces.expand("{a,a,,b}", { nodupes: true, noempty: true }),
    ["a", "b"],
  );
  assert.deepEqual(braces.expand("{1..6}", { step: 2 }), ["1", "3", "5"]);
  assert.equal(braces.stringify(braces.parse("{a,{b,c}}")), "{a,{b,c}}");
});

test("real micromatch and fast-glob discover the intended files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "privcloud-globs-"));
  try {
    for (const name of [
      "src/one.ts",
      "src/nested/two.tsx",
      "src/three.js",
      "docs/guide.md",
      "docs/nested/intro.mdx",
    ]) {
      const filename = path.join(directory, name);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, "test");
    }
    const pattern = "src/**/*.{ts,tsx}";
    assert.deepEqual(
      require("fast-glob").sync(pattern, { cwd: directory }).sort(),
      ["src/nested/two.tsx", "src/one.ts"],
    );
    assert.deepEqual(
      require("micromatch")(
        ["src/one.ts", "src/three.js", "src/nested/two.tsx"],
        pattern,
      ).sort(),
      ["src/nested/two.tsx", "src/one.ts"],
    );
    assert.deepEqual(
      require("fast-glob")
        .sync("docs/**/*.{md,mdx}", { cwd: directory })
        .sort(),
      ["docs/guide.md", "docs/nested/intro.mdx"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all entry points reject resource attacks within a bounded process", () => {
  const source = `
    const assert = require('node:assert/strict');
    const braces = require('braces');
    const limited = { code: 'ERR_BRACE_PATTERN_LIMIT' };
    for (const pattern of [
      '{'.repeat(12000) + 'x' + '}'.repeat(12000),
      '{a,b}'.repeat(129),
      'x'.repeat(65537),
    ]) {
      for (const fn of [braces, braces.parse, braces.compile, braces.stringify, braces.expand, braces.create]) {
        assert.throws(() => fn(pattern), limited);
      }
    }
    for (const pattern of ['{a,b}'.repeat(11), '{1..1000000000000000}', 'x'.repeat(2200) + '{1..1000}']) {
      assert.throws(() => braces.expand(pattern, { rangeLimit: false }), limited);
      assert.throws(() => braces.create(pattern, { expand: true }), limited);
      assert.throws(() => braces(pattern, { expand: true }), limited);
    }
    const ast = { pattern: '{'.repeat(1000) + 'x' };
    ast.arms = [[ast]];
    for (const fn of [braces.compile, braces.stringify, braces.expand]) assert.throws(() => fn(ast), limited);
    assert.ok(braces.compile('{1..1000000000000000}').length < 1000);
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=commonjs", "--eval", source],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
