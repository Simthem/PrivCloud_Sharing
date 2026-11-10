#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "CVE-2026-122146: bound ZIP extraction before allocation";
const ORIGINAL_HASHES = {
  "esm/browser.js":
    "b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1",
  "esm/index.mjs":
    "8d75534a30a0580608e1271c13d70943ed4cd3589fddff7b1197748036a5116e",
  "lib/browser.cjs":
    "cbe7f75f83e0ca95ec7f3854fcdc8f854f488485d0ecf03c3a0a7ff29765c690",
  "lib/node.cjs":
    "befa44cd80a1da830179db9e57930050a2e460ca3df13f0b05f83f52b1491818",
  "lib/index.cjs":
    "36967d6a4576f414f5a3611cfc866fa4245c05582048332ac139a174c63d56e0",
  "umd/index.js":
    "462ef8041fc970e3615a20a9dd2b2e3047a073b2da729ef4f02b634bba8b7b83",
};

// This function is embedded in each distributed entry point. It must be standalone.
function zipAllocationPreflight(data, maxWorkers) {
  const fail = () => {
    throw new RangeError(
      "ZIP extraction exceeds limits or has unsupported metadata",
    );
  };
  const maxEntry = 32 * 1024 * 1024;
  const maxTotal = 64 * 1024 * 1024;
  if (!data || data.length < 22 || data.length > maxTotal) fail();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  let end = data.length - 22;
  const lower = Math.max(0, data.length - 65557);
  // Match the upstream reader's first EOCD candidate, including inside comments.
  while (end >= lower && u32(end) !== 0x06054b50) end--;
  if (end < lower || end + 22 + u16(end + 20) !== data.length) fail();
  const count = u16(end + 10);
  const start = u32(end + 16);
  const directoryEnd = start + u32(end + 12);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    count !== u16(end + 8) ||
    count > 1024 ||
    directoryEnd !== end ||
    directoryEnd - start > 2 * 1024 * 1024 ||
    (end >= 20 && u32(end - 20) === 0x07064b50)
  )
    fail();
  let cursor = start;
  let total = 0;
  let workers = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || u32(cursor) !== 0x02014b50) fail();
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const compressed = u32(cursor + 20);
    const expanded = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const next = cursor + 46 + nameLength + u16(cursor + 30) + u16(cursor + 32);
    const local = u32(cursor + 42);
    if (
      flags & 0x41 ||
      ![0, 8].includes(method) ||
      nameLength > 1024 ||
      next > directoryEnd ||
      u16(cursor + 34) ||
      compressed > maxTotal ||
      expanded > maxEntry ||
      (method === 0 && compressed !== expanded) ||
      local + 30 > start
    )
      fail();
    if (
      maxWorkers !== undefined &&
      method === 8 &&
      expanded >= 524288 &&
      compressed <= 0.8 * expanded &&
      ++workers > maxWorkers
    )
      fail();
    total += expanded;
    if (total > maxTotal) fail();
    let name = "";
    for (let n = 0; n < nameLength; n++)
      name += String.fromCharCode(data[cursor + 46 + n]);
    if (
      names.has(name) ||
      ["__proto__", "constructor", "prototype"].includes(name)
    )
      fail();
    names.add(name);
    if (
      u32(local) !== 0x04034b50 ||
      u16(local + 8) !== method ||
      u16(local + 6) !== flags ||
      u16(local + 26) !== nameLength
    )
      fail();
    const body = local + 30 + nameLength + u16(local + 28);
    if (body + compressed > start) fail();
    for (let n = 0; n < nameLength; n++) {
      if (data[local + 30 + n] !== data[cursor + 46 + n]) fail();
    }
    if (
      !(flags & 8) &&
      (u32(local + 18) !== compressed || u32(local + 22) !== expanded)
    )
      fail();
    cursor = next;
  }
  if (cursor !== directoryEnd) fail();
}

function unzip(data, opts, callback) {
  if (!callback) {
    callback = opts;
    opts = {};
  }
  if (typeof callback !== "function")
    return unzipUnchecked(data, opts, callback);
  try {
    zipAllocationPreflight(data, 4);
  } catch (error) {
    const defer =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (fn) => setTimeout(fn, 0);
    defer(() => callback(error, null));
    return function () {};
  }
  return unzipUnchecked(data, opts, callback);
}
function unzipSync(data, opts) {
  zipAllocationPreflight(data);
  return unzipSyncUnchecked(data, opts);
}

function helper(format) {
  const exported = format === "esm" ? "export " : "";
  return `\n// ${MARKER}\n${zipAllocationPreflight.toString()}\n${exported}${unzip.toString()}\n${exported}${unzipSync.toString()}\n`;
}
const hash = (source) => createHash("sha256").update(source).digest("hex");

function transform(source, filename) {
  assert.equal(
    hash(source),
    ORIGINAL_HASHES[filename],
    `Unexpected upstream fflate source: ${filename}`,
  );
  if (filename === "umd/index.js") {
    assert.equal(source.split("return _e}").length, 2);
    return source
      .replace("return _e}", `${helper("umd")}return _e}`)
      .replace(
        "_e.unzip=zn,_e.unzipSync=kn;",
        "_e.unzip=unzip,_e.unzipSync=unzipSync;",
      )
      .replace("function zn(", "function unzipUnchecked(")
      .replace("function kn(", "function unzipSyncUnchecked(");
  }
  const prefix = filename.startsWith("esm/") ? "export " : "";
  const asyncAnchor = `${prefix}function unzip(data, opts, cb) {`;
  const syncAnchor = `${prefix}function unzipSync(data, opts) {`;
  assert.equal(source.split(asyncAnchor).length, 2);
  assert.equal(source.split(syncAnchor).length, 2);
  const unchecked = "function unzipUnchecked(data, opts, cb) {";
  return source
    .replace(asyncAnchor, unchecked)
    .replace(syncAnchor, "function unzipSyncUnchecked(data, opts) {")
    .replace(unchecked, helper(prefix ? "esm" : "cjs") + unchecked);
}

function assertPatchedSource(source, filename) {
  const format = filename.startsWith("esm/")
    ? "esm"
    : filename === "umd/index.js"
      ? "umd"
      : "cjs";
  const patch = helper(format);
  assert.equal(
    source.split(patch).length,
    2,
    `Missing or altered fflate guard: ${filename}`,
  );
  let original = source.replace(patch, "");
  if (format === "umd") {
    original = original
      .replace(
        "_e.unzip=unzip,_e.unzipSync=unzipSync;",
        "_e.unzip=zn,_e.unzipSync=kn;",
      )
      .replace("function unzipUnchecked(", "function zn(")
      .replace("function unzipSyncUnchecked(", "function kn(");
  } else {
    const prefix = format === "esm" ? "export " : "";
    original = original
      .replace(
        "function unzipUnchecked(data, opts, cb) {",
        `${prefix}function unzip(data, opts, cb) {`,
      )
      .replace(
        "function unzipSyncUnchecked(data, opts) {",
        `${prefix}function unzipSync(data, opts) {`,
      );
  }
  assert.equal(
    source,
    transform(original, filename),
    `Altered fflate patch: ${filename}`,
  );
}

function regularFile(root, filename) {
  const stats = fs.lstatSync(filename);
  assert.ok(
    stats.isFile() && !stats.isSymbolicLink(),
    `Unsafe fflate file: ${filename}`,
  );
  assert.equal(
    fs.realpathSync(filename),
    filename,
    `Indirect fflate path: ${filename}`,
  );
  const relative = path.relative(root, filename);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
}

function patchInstalledFflate() {
  const requested = path.resolve("node_modules");
  assert.ok(
    fs.lstatSync(requested).isDirectory() &&
      !fs.lstatSync(requested).isSymbolicLink(),
  );
  const root = fs.realpathSync(requested);
  const pending = [root];
  const packages = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        assert.notEqual(
          entry.name,
          "fflate",
          "fflate must not be an indirect package",
        );
        continue;
      }
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const child = path.join(directory, entry.name);
      if (entry.name === "fflate") packages.push(child);
      else pending.push(child);
    }
  }
  assert.ok(packages.length, "fflate dependency is missing");
  const updates = [];
  for (const packageRoot of packages) {
    const manifestPath = path.join(packageRoot, "package.json");
    regularFile(root, manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, "fflate");
    assert.equal(
      manifest.version,
      "0.8.3",
      "Review the fflate patch for this version",
    );
    for (const filename of Object.keys(ORIGINAL_HASHES)) {
      const target = path.join(packageRoot, filename);
      regularFile(root, target);
      const source = fs.readFileSync(target, "utf8");
      if (source.includes(MARKER)) assertPatchedSource(source, filename);
      else updates.push([target, transform(source, filename)]);
    }
  }
  // Validate every entry point before changing the installation.
  for (const [filename, source] of updates) fs.writeFileSync(filename, source);
  return packages.length;
}

if (require.main === module) {
  assert.equal(
    process.argv.length,
    2,
    "patch-fflate.cjs accepts no paths or options",
  );
  process.stdout.write(
    `Bounded ZIP extraction verified in ${patchInstalledFflate()} fflate package(s)\n`,
  );
}
module.exports = {
  zipAllocationPreflight,
  transform,
  assertPatchedSource,
  patchInstalledFflate,
  ORIGINAL_HASHES,
};
