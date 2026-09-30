import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const frontend = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const frontendLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

function assertFixedVersion(actual, minimum) {
  assert.match(actual, /^\d+\.\d+\.\d+$/);
  const parsed = actual.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  const difference = parsed
    .map((part, index) => part - floor[index])
    .find((part) => part !== 0);
  assert.ok(
    difference === undefined || difference > 0,
    `${actual} must be at least ${minimum}`,
  );
}

test("the frontend locks fixed Next.js, Axios and DOMPurify versions", () => {
  for (const [name, minimum] of [
    ["next", "16.3.6"],
    ["axios", "1.20.0"],
    ["dompurify", "3.4.16"],
  ]) {
    const version = frontendLock.packages[`node_modules/${name}`].version;
    assertFixedVersion(version, minimum);
    assert.equal(frontend.overrides[name], version);
  }
  for (const name of ["next", "axios"]) {
    const version = frontendLock.packages[`node_modules/${name}`].version;
    assert.equal(frontend.dependencies[name], version);
    assert.equal(require(`${name}/package.json`).version, version);
  }
  assert.equal(
    frontend.devDependencies["@next/eslint-plugin-next"],
    frontend.dependencies.next,
  );
  assert.equal(
    frontendLock.packages["node_modules/@next/eslint-plugin-next"].version,
    frontend.dependencies.next,
  );
});

test("backend and documentation locks retain their security fixes", () => {
  for (const [directory, name, minimum] of [
    ["backend", "axios", "1.20.0"],
    ["backend", "fast-uri", "3.1.8"],
    ["docs", "fast-uri", "3.1.8"],
  ]) {
    const manifest = JSON.parse(
      readFileSync(
        new URL(`../../${directory}/package.json`, import.meta.url),
        "utf8",
      ),
    );
    const lock = JSON.parse(
      readFileSync(
        new URL(`../../${directory}/package-lock.json`, import.meta.url),
        "utf8",
      ),
    );
    const version = lock.packages[`node_modules/${name}`].version;
    assertFixedVersion(version, minimum);
    assert.equal(manifest.overrides[name], version);
  }
});

test("HTML sanitization still rejects event handlers and script URLs", async () => {
  const { default: purifier } = await import("isomorphic-dompurify");
  const sanitized = purifier.sanitize(
    '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">link</a><script>alert(1)</script>',
  );
  assert.doesNotMatch(sanitized, /onerror|javascript:|<script/i);
  assert.match(sanitized, /link/);
});
