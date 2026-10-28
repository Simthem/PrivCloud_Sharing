import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import qs from "qs";

const docsRoot = fileURLToPath(new URL("../", import.meta.url));

test("locked query parsers, worker pools and selector parsers include the security fixes", () => {
  const lock = JSON.parse(
    readFileSync(path.join(docsRoot, "package-lock.json")),
  );
  for (const [name, expected] of [
    ["qs", "6.17.0"],
    ["tinypool", "2.1.2"],
    ["postcss-selector-parser", "7.1.6"],
  ]) {
    const entries = Object.entries(lock.packages).filter(
      ([location]) =>
        location.endsWith(`/node_modules/${name}`) ||
        location === `node_modules/${name}`,
    );
    assert.ok(entries.length > 0, `${name} must be installed`);
    for (const [location, entry] of entries)
      assert.equal(entry.version, expected, location);
  }
});

test("Tinypool ignores inherited worker and task options", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "privcloud-worker-security-"),
  );
  try {
    const legitimate = path.join(directory, "legitimate.mjs");
    const substituted = path.join(directory, "substituted.mjs");
    writeFileSync(
      legitimate,
      "export default (value) => ({ value: value * 2, injected: process.env.PRIVCLOUD_POLLUTION_FIXTURE ?? null });",
    );
    writeFileSync(
      substituted,
      'export default () => ({ value: "substituted" });',
    );
    const probe = path.join(directory, "probe.mjs");
    writeFileSync(
      probe,
      `
      import assert from "node:assert/strict";
      import Tinypool from ${JSON.stringify(new URL("../node_modules/tinypool/dist/index.js", import.meta.url).href)};
      Object.prototype.execArgv = ["--require", ${JSON.stringify(path.join(directory, "missing.cjs"))}];
      Object.prototype.env = { PRIVCLOUD_POLLUTION_FIXTURE: "inherited" };
      Object.prototype.filename = ${JSON.stringify(substituted)};
      let pool;
      try {
        pool = new Tinypool({ filename: ${JSON.stringify(legitimate)}, minThreads: 1, maxThreads: 1 });
        assert.deepEqual(await pool.run(21, {}), { value: 42, injected: null });
      } finally {
        delete Object.prototype.execArgv;
        delete Object.prototype.env;
        delete Object.prototype.filename;
        await pool?.destroy();
      }
    `,
    );
    const result = spawnSync(process.execPath, [probe], {
      cwd: docsRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("flat CSS selectors are parsed within a bounded execution time", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      `
    const assert = require("node:assert/strict");
    const parser = require("postcss-selector-parser");
    const selector = ".a".repeat(40_000);
    assert.equal(parser().astSync(selector).first.nodes.length, 40_000);
    const normal = 'article > a[href="/download"]:not(.disabled), #team';
    assert.equal(parser().processSync(normal), normal);
  `,
    ],
    { cwd: docsRoot, encoding: "utf8", timeout: 4_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test("qs comma arrays safely serialize untrusted toString properties", () => {
  // GHSA-6pq8-jhm2-2vcw / SNYK-JS-QS-20943482. Each vector threw on 6.16.0.
  const inputs = [
    qs.parse("a[0][toString]=x", { allowPrototypes: true }),
    JSON.parse('{"a":[{"toString":"x"}]}'),
    qs.parse("a[][b]=c", { plainObjects: true }),
  ];
  for (const input of inputs)
    for (const encodeValuesOnly of [false, true])
      assert.equal(
        decodeURIComponent(
          qs.stringify(input, { arrayFormat: "comma", encodeValuesOnly }),
        ),
        "a=[object Object]",
      );
  assert.equal(
    decodeURIComponent(
      qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" }),
    ),
    "a=one,two",
  );
});
