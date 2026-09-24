import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const docsRoot = fileURLToPath(new URL("../", import.meta.url));
const runParser = (source) =>
  spawnSync(process.execPath, ["--input-type=commonjs", "--eval", source], {
    cwd: docsRoot,
    encoding: "utf8",
    timeout: 1_000,
  });

const assertRejectedWithoutHang = (name, source) => {
  const result = runParser(source);
  assert.notEqual(result.error?.code, "ETIMEDOUT", `${name} parser hung`);
  assert.equal(result.signal, null, `${name} parser was killed`);
  assert.equal(
    result.status,
    0,
    `${name} parser did not reject the malicious input:\n${result.stderr}`,
  );
};

test("image-size is a release that rejects malformed boxes by itself", () => {
  const { version } = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../node_modules/image-size/package.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const [major, minor, patch] = version.split(".").map(Number);
  assert.ok(
    major > 2 || (major === 2 && (minor > 0 || patch >= 4)),
    `image-size ${version} predates the upstream fix released in 2.0.4`,
  );
  assert.deepEqual(
    readdirSync(fileURLToPath(new URL("../patches/", import.meta.url))).filter(
      (name) => name.startsWith("image-size+"),
    ),
    [],
    "a stale image-size patch would be applied over the fixed release",
  );
});

test("malformed ICNS entries cannot stall the event loop", () => {
  assertRejectedWithoutHang(
    "ICNS",
    `
      const { ICNS } = require("image-size/types/icns");
      const payload = Uint8Array.from([
        0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10,
        0x69, 0x73, 0x33, 0x32, 0x00, 0x00, 0x00, 0x00,
      ]);
      try { ICNS.calculate(payload); process.exit(2); } catch { process.exit(0); }
    `,
  );
});

test("malformed HEIF boxes cannot stall the event loop", () => {
  assertRejectedWithoutHang(
    "HEIF",
    `
      const { HEIF } = require("image-size/types/heif");
      const payload = Uint8Array.from([
        0x00,0x00,0x00,0x10, 0x66,0x74,0x79,0x70,
        0x61,0x76,0x69,0x66, 0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x24, 0x6d,0x65,0x74,0x61,
        0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x08, 0x69,0x70,0x72,0x70,
        0x00,0x00,0x00,0x14, 0x69,0x70,0x63,0x6f,
        0x00,0x00,0x00,0x00, 0x69,0x73,0x70,0x65,
        0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
      ]);
      try { HEIF.calculate(payload); process.exit(2); } catch { process.exit(0); }
    `,
  );
});

test("malformed JXL partial streams cannot stall the event loop", () => {
  assertRejectedWithoutHang(
    "JXL",
    `
      const { JXL } = require("image-size/types/jxl");
      const payload = Uint8Array.from([
        0x00,0x00,0x00,0x00, 0x6a,0x78,0x6c,0x70,
        0x00,0x00,0x00,0x00, 0xff,0x0a,0x00,0x00,
      ]);
      try { JXL.calculate(payload); process.exit(2); } catch { process.exit(0); }
    `,
  );
});

test("malformed JPEG 2000 boxes cannot stall the event loop", () => {
  assertRejectedWithoutHang(
    "JP2",
    `
      const { JP2 } = require("image-size/types/jp2");
      const payload = Uint8Array.from([
        0x00,0x00,0x00,0x0c, 0x6a,0x50,0x20,0x20, 0x0d,0x0a,0x87,0x0a,
        0x00,0x00,0x00,0x14, 0x66,0x74,0x79,0x70, 0x6a,0x70,0x32,0x20,
        0x00,0x00,0x00,0x00, 0x6a,0x70,0x32,0x20,
        0x00,0x00,0x00,0x00, 0x6a,0x70,0x32,0x68,
        0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
      ]);
      try { JP2.calculate(payload); process.exit(2); } catch { process.exit(0); }
    `,
  );
});
