import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.dirname(require.resolve("fflate/package.json"));
const patcherPath = path.join(root, "../scripts/patch-fflate.cjs");
const { assertPatchedSource, ORIGINAL_HASHES } = require(patcherPath);
const fflate = require("fflate");
const limit = 32 * 1024 * 1024;
const cases = [
  ["lib/node.cjs", require(path.join(packageRoot, "lib/node.cjs"))],
  ["lib/browser.cjs", require(path.join(packageRoot, "lib/browser.cjs"))],
  ["lib/index.cjs", require(path.join(packageRoot, "lib/index.cjs"))],
  [
    "esm/index.mjs",
    await import(pathToFileURL(path.join(packageRoot, "esm/index.mjs"))),
  ],
  [
    "esm/browser.js",
    await import(pathToFileURL(path.join(packageRoot, "esm/browser.js"))),
  ],
  ["umd/index.js", require(path.join(packageRoot, "umd/index.js"))],
];

function archive(count = 1, level = 6, name) {
  const entries = Object.create(null);
  for (let i = 0; i < count; i++)
    entries[name ? "x".repeat(name.length) : `part-${i}`] =
      fflate.strToU8("hello");
  const bytes = fflate.zipSync(entries, { level });
  if (name) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = view.getUint32(bytes.length - 6, true);
    for (let i = 0; i < name.length; i++) {
      bytes[30 + i] = name.charCodeAt(i);
      bytes[central + 46 + i] = name.charCodeAt(i);
    }
  }
  return bytes;
}
function declared(bytes, expanded) {
  bytes = bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let central = view.getUint32(bytes.length - 6, true);
  const count = view.getUint16(bytes.length - 12, true);
  for (let i = 0; i < count; i++) {
    const local = view.getUint32(central + 42, true);
    view.setUint32(central + 24, expanded, true);
    view.setUint32(local + 22, expanded, true);
    central +=
      46 +
      view.getUint16(central + 28, true) +
      view.getUint16(central + 30, true) +
      view.getUint16(central + 32, true);
  }
  return bytes;
}
function instrument() {
  const allocations = [];
  const Uint8 = new Proxy(Uint8Array, {
    construct(target, args) {
      if (typeof args[0] === "number") {
        allocations.push(args[0]);
        if (args[0] > 1024 * 1024) throw new Error("allocation intercepted");
      }
      return Reflect.construct(target, args);
    },
  });
  const context = {
    Uint8Array: Uint8,
    Uint16Array,
    Uint32Array,
    Int32Array,
    DataView,
    TextDecoder,
    TextEncoder,
    queueMicrotask,
    setTimeout,
    module: { exports: {} },
    exports: {},
  };
  const source = readFileSync(path.join(packageRoot, "umd/index.js"), "utf8");
  vm.runInNewContext(
    source.replace("return _e}", "_e.control=unzipSyncUnchecked;return _e}"),
    context,
    { timeout: 1000 },
  );
  allocations.length = 0;
  return { api: context.module.exports, allocations };
}
const asyncUnzip = (api, bytes, options) =>
  new Promise((resolve, reject) => {
    api.unzip(bytes, options ?? {}, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });

test("the installation pins 0.8.3 and verifies every guarded public entry point", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.dependencies.fflate, "0.8.3");
  assert.match(
    manifest.scripts.postinstall,
    /node \.\.\/scripts\/patch-fflate\.cjs/,
  );
  for (const script of ["dev", "prebuild"]) {
    assert.ok(
      manifest.scripts[script].startsWith(
        "node ../scripts/patch-fflate.cjs && ",
      ),
    );
  }
  assert.equal(lock.packages[""].dependencies.fflate, "0.8.3");
  assert.equal(lock.packages["node_modules/fflate"].version, "0.8.3");
  for (const [filename] of cases)
    assertPatchedSource(
      readFileSync(path.join(packageRoot, filename), "utf8"),
      filename,
    );
  assert.equal(cases.length, Object.keys(ORIGINAL_HASHES).length);
});

test("declared per-entry, cumulative and ZIP64 sizes are rejected by all sync and async formats", async () => {
  for (const [filename, api] of cases) {
    for (const bytes of [
      declared(archive(), 1024 ** 3),
      declared(archive(), 0xffffffff),
      declared(archive(3), limit),
    ]) {
      assert.throws(
        () => api.unzipSync(bytes),
        /ZIP extraction exceeds limits/,
        filename,
      );
      await assert.rejects(
        asyncUnzip(api, bytes),
        /ZIP extraction exceeds limits/,
        filename,
      );
    }
  }
});

test("the original allocation is intercepted without allocating it; the guard allocates nothing", () => {
  const { api, allocations } = instrument();
  const bytes = declared(archive(), 1024 ** 3);
  assert.throws(() => api.control(bytes), /allocation intercepted/);
  assert.ok(allocations.includes(1024 ** 3));
  allocations.length = 0;
  assert.throws(() => api.unzipSync(bytes), /ZIP extraction exceeds limits/);
  assert.deepEqual(allocations, []);
  assert.throws(
    () => api.unzipSync(declared(archive(3), limit)),
    /ZIP extraction exceeds limits/,
  );
  assert.deepEqual(allocations, []);
});

test("async rejection is deferred and delivered once before a worker or output allocation", async () => {
  const { api, allocations } = instrument();
  let synchronous = true,
    callbacks = 0;
  await new Promise((resolve, reject) => {
    const terminate = api.unzip(
      declared(archive(), 1024 ** 3),
      (error, result) => {
        try {
          callbacks++;
          assert.equal(synchronous, false);
          assert.match(error.message, /ZIP extraction exceeds limits/);
          assert.equal(result, null);
          resolve();
        } catch (failure) {
          reject(failure);
        }
      },
    );
    assert.equal(typeof terminate, "function");
    synchronous = false;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks, 1);
  assert.deepEqual(allocations, []);
});

test("async extraction rejects a worker fan-out before starting jobs", async () => {
  const { api, allocations } = instrument();
  await assert.rejects(
    asyncUnzip(api, declared(archive(5), 600_000)),
    /ZIP extraction exceeds limits/,
  );
  assert.deepEqual(allocations, []);
});

test("normal stored, deflated, Unicode and empty ZIPs and filters keep working", async () => {
  for (const [filename, api] of cases) {
    for (const level of [0, 6]) {
      const bytes = api.zipSync(
        {
          "données/été.txt": api.strToU8("Bonjour"),
          other: api.strToU8("world"),
        },
        { level },
      );
      const padded = new Uint8Array(bytes.length + 8);
      padded.set(bytes, 4);
      const slice = padded.subarray(4, 4 + bytes.length);
      assert.equal(
        api.strFromU8(api.unzipSync(slice)["données/été.txt"]),
        "Bonjour",
        filename,
      );
      const selected = await asyncUnzip(api, slice, {
        filter: (file) => file.name === "other",
      });
      assert.deepEqual(Object.keys(selected), ["other"]);
      assert.equal(api.strFromU8(selected.other), "world");
    }
    assert.deepEqual(Object.keys(api.unzipSync(api.zipSync({}))), []);
  }
});

test("the asynchronous worker path still extracts a legitimate compressed entry", async () => {
  const bytes = fflate.zipSync({ data: new Uint8Array(600_000).fill(42) });
  const result = await asyncUnzip(fflate, bytes);
  assert.equal(result.data.length, 600_000);
  assert.ok(result.data.every((value) => value === 42));
});

test("stored-size mismatches, malformed bounds and deceptive comment headers fail before extraction", () => {
  const stored = declared(archive(1, 0), 1);
  const badOffset = archive();
  const view = new DataView(
    badOffset.buffer,
    badOffset.byteOffset,
    badOffset.byteLength,
  );
  view.setUint32(
    view.getUint32(badOffset.length - 6, true) + 42,
    0xffffffff,
    true,
  );
  const withComment = new Uint8Array(archive().length + 32);
  withComment.set(archive());
  const commentView = new DataView(withComment.buffer);
  commentView.setUint16(withComment.length - 32 - 2, 32, true);
  commentView.setUint32(withComment.length - 22, 0x06054b50, true);
  for (const bytes of [
    stored,
    badOffset,
    withComment,
    new Uint8Array(0),
    new Uint8Array(21),
  ]) {
    assert.throws(
      () => fflate.unzipSync(bytes),
      /ZIP extraction exceeds limits/,
    );
  }
  for (const name of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () => fflate.unzipSync(archive(1, 6, name)),
      /ZIP extraction exceeds limits/,
    );
  }
});

test("entry count and archive input budgets are enforced before iteration or output allocation", () => {
  assert.throws(
    () => fflate.unzipSync(archive(1025)),
    /ZIP extraction exceeds limits/,
  );
  const { api, allocations } = instrument();
  // An array-shaped descriptor proves the length gate runs before opening a buffer.
  assert.throws(
    () => api.unzipSync({ length: 64 * 1024 * 1024 + 1 }),
    /ZIP extraction exceeds limits/,
  );
  assert.deepEqual(allocations, []);
});

test("ZIP creation remains streamed beyond the extraction limits", () => {
  let total = 0,
    final = false,
    largest = 0;
  const zip = new fflate.Zip((error, bytes, done) => {
    assert.ifError(error);
    total += bytes.length;
    largest = Math.max(largest, bytes.length);
    final ||= done;
  });
  const entry = new fflate.ZipPassThrough("large.bin");
  zip.add(entry);
  const chunk = new Uint8Array(65536).fill(42);
  for (let i = 0; i < 1025; i++) entry.push(chunk, false);
  entry.push(new Uint8Array(0), true);
  zip.end();
  assert.equal(final, true);
  assert.ok(total > 64 * 1024 * 1024);
  assert.ok(largest <= 65536);
});

test("the patcher is idempotent and fails closed on altered files, versions and indirect packages", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "zip-guard-"));
  const destination = path.join(directory, "node_modules/fflate");
  const run = (...args) =>
    spawnSync(process.execPath, [patcherPath, ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
    });
  try {
    mkdirSync(path.dirname(destination));
    cpSync(packageRoot, destination, { recursive: true });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    assert.notEqual(run("../outside").status, 0);
    const target = path.join(destination, "esm/browser.js");
    const source = readFileSync(target, "utf8");
    writeFileSync(
      target,
      source.replace("32 * 1024 * 1024", "33 * 1024 * 1024"),
    );
    assert.notEqual(run().status, 0);
    writeFileSync(target, source);
    const manifestPath = path.join(destination, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, version: "0.8.4" }),
    );
    assert.notEqual(run().status, 0);
    rmSync(destination, { recursive: true });
    symlinkSync(packageRoot, destination, "dir");
    assert.notEqual(run().status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("both Docker paths copy and recheck the guard in dependency and cached-builder stages", () => {
  for (const name of ["Dockerfile", "Dockerfile.full-build"]) {
    const source = readFileSync(path.join(root, "..", name), "utf8");
    const deps = source
      .split("FROM base AS frontend-deps")[1]
      .split(/\nFROM /)[0];
    assert.match(
      deps,
      /COPY scripts\/patch-fflate\.cjs \/opt\/app\/scripts\/patch-fflate\.cjs/,
    );
    const builder = source
      .split("FROM base AS frontend-builder")[1]
      .split(/\nFROM /)[0];
    assert.match(builder, /RUN node \/opt\/app\/scripts\/patch-fflate\.cjs/);
  }
});

test("scanner exceptions cover only the reviewed fflate version and expire together", () => {
  const issue = "SNYK-JS-FFLATE-22392372";
  const policies = ["../.snyk", ".snyk"].map((name) =>
    require("yaml").parse(readFileSync(path.join(root, name), "utf8")),
  );
  const rules = policies.map((policy) => policy.ignore[issue]);
  assert.deepEqual(rules[0], rules[1]);
  assert.equal(rules[0].length, 1);
  assert.deepEqual(Object.keys(rules[0][0]), ["* > fflate@0.8.3"]);
  const rule = rules[0][0]["* > fflate@0.8.3"];
  assert.match(rule.expires, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.ok(Number.isFinite(Date.parse(rule.expires)));
  assert.match(rule.reason, /all six entry points/);
  assert.match(rule.reason, /not the upstream npm artifact/);
});

test("runtime images carry the version-scoped VEX with the local mitigation", () => {
  const dockerRoot = path.join(root, "../.docker");
  const vexName = existsSync(path.join(dockerRoot, "privcloud.vex.json"))
    ? "privcloud.vex.json"
    : "vex.json";
  const document = JSON.parse(
    readFileSync(path.join(dockerRoot, vexName), "utf8"),
  );
  assert.equal(document["@context"], "https://openvex.dev/ns/v0.2.0");
  const statements = document.statements.filter(
    (item) => item.vulnerability.name === "CVE-2026-122146",
  );
  assert.equal(statements.length, 1);
  const statement = statements[0];
  const scout = JSON.parse(
    readFileSync(path.join(root, "../package.json"), "utf8"),
  ).scripts["security:scout"];
  assert.ok(scout.includes(`--vex-location .docker/${vexName}`));
  assert.ok(scout.includes("--vex-author='PrivCloud Security Team'"));
  assert.ok(scout.includes("--only-vex-affected"));
  assert.ok(scout.includes("--exit-code"));
  assert.deepEqual(statement.products, [{ "@id": "pkg:npm/fflate@0.8.3" }]);
  assert.equal(statement.status, "not_affected");
  assert.equal(statement.justification, "inline_mitigations_already_exist");
  assert.match(
    statement.impact_statement,
    /Only the fflate 0\.8\.3 copies patched by this repository/,
  );
  assert.match(statement.impact_statement, /32 MiB/);
  assert.match(statement.impact_statement, /64 MiB/);
  assert.match(statement.impact_statement, /upstream npm artifact is fixed/);
  const policy = require("yaml").parse(
    readFileSync(path.join(root, ".snyk"), "utf8"),
  );
  const expiry = policy.ignore["SNYK-JS-FFLATE-22392372"][0][
    "* > fflate@0.8.3"
  ].expires.slice(0, 10);
  assert.ok(statement.impact_statement.includes(`Reassess by ${expiry}`));
  for (const name of ["Dockerfile", "Dockerfile.full-build"]) {
    const runtime = readFileSync(path.join(root, "..", name), "utf8").split(
      " AS runner\n",
    )[1];
    assert.ok(
      runtime.includes(
        `COPY .docker/${vexName} /usr/share/security/privcloud.vex.json`,
      ),
    );
  }
});

test("the release scanner policy stays behind frontend guard regressions", () => {
  const jobPath = path.join(root, "../ci/gitlab/security.yml");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (existsSync(jobPath)) {
    const jobs = require("yaml").parse(readFileSync(jobPath, "utf8"));
    assert.ok(
      jobs.snyk.needs.some(
        (job) => job.job === "frontend:build" && !job.optional,
      ),
    );
    const builds = require("yaml").parse(
      readFileSync(path.join(root, "../ci/gitlab/build.yml"), "utf8"),
    );
    assert.ok(builds["frontend:build"].script.includes("npm test"));
    assert.equal(manifest.scripts.test, "npm run test:unit");
    assert.ok(manifest.scripts["test:unit"].includes("test/*.test.mjs"));
  } else {
    const workflow = require("yaml").parse(
      readFileSync(
        path.join(root, "../.github/workflows/open-source-release-gate.yml"),
        "utf8",
      ),
    );
    assert.ok(
      workflow.jobs["release-gate"].steps.some(
        (step) => step.run === "npm run test:release",
      ),
    );
    const scripts = JSON.parse(
      readFileSync(path.join(root, "../package.json"), "utf8"),
    ).scripts;
    assert.ok(scripts["test:release"].includes("npm run test:frontend"));
    assert.ok(scripts["test:frontend"].includes("frontend/test/*.test.mjs"));
  }
});
