import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const docsRoot = fileURLToPath(new URL("../", import.meta.url));
const patchPath = fileURLToPath(
  new URL("../patches/image-size+2.0.2.patch", import.meta.url),
);

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

test("patch-package covers every published CommonJS and ESM parser bundle", () => {
  const patch = readFileSync(patchPath, "utf8");
  assert.equal((patch.match(/if \(boxSize === 0\) return;/g) ?? []).length, 18);
  assert.equal(
    (patch.match(/Invalid ICNS entry length/g) ?? []).length,
    12,
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
