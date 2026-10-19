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

test("the frontend locks fixed Next.js, Axios, DOMPurify and Undici versions", () => {
  for (const [name, minimum] of [
    ["next", "16.4.1"],
    ["axios", "1.20.0"],
    ["dompurify", "3.4.16"],
    ["undici", "7.30.1"],
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

test("all frontend and backend Undici copies retain the October security fixes", () => {
  for (const directory of ["frontend", "backend"]) {
    const manifestUrl = new URL(
      `../../${directory}/package.json`,
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
    const lock = JSON.parse(
      readFileSync(new URL("./package-lock.json", manifestUrl), "utf8"),
    );
    assertFixedVersion(manifest.overrides.undici, "7.30.1");
    assert.equal(
      lock.packages[""].dependencies?.undici,
      manifest.dependencies.undici,
    );
    const copies = Object.entries(lock.packages).filter(([location]) =>
      location.endsWith("node_modules/undici"),
    );
    assert.ok(copies.length > 0, `${directory} must lock Undici`);
    for (const [location, pkg] of copies) {
      assert.equal(
        pkg.version,
        manifest.overrides.undici,
        `${directory}/${location}`,
      );
    }
    if (directory === "backend") {
      // Frontend CI installs only frontend dependencies. The backend suite
      // checks its installed package, while this suite always checks its lock.
      assert.equal(manifest.dependencies.undici, manifest.overrides.undici);
    } else {
      const installedRequire = createRequire(manifestUrl);
      assert.equal(
        installedRequire("undici/package.json").version,
        manifest.overrides.undici,
      );
      const jsdomRequire = createRequire(installedRequire.resolve("jsdom"));
      assert.equal(
        jsdomRequire("undici/package.json").version,
        manifest.overrides.undici,
      );
    }
  }
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

test("the proxy dependency no longer installs the vulnerable sprintf-js logger", () => {
  for (const directory of ["frontend", "backend"]) {
    const lock = JSON.parse(
      readFileSync(
        new URL(`../../${directory}/package-lock.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(lock.packages["node_modules/global-agent"].version, "4.1.3");
    assert.ok(
      !Object.keys(lock.packages).some((location) =>
        location.endsWith("/sprintf-js"),
      ),
    );
  }
});
