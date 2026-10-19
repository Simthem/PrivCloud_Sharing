import assert from "node:assert/strict";
import test from "node:test";
import { rawPreviewFixture } from "./fixtures/raw-previews.cjs";
import { readRawRangePreview } from "../src/utils/rawPreview.util.ts";
import { createPreviewByteSource } from "../src/utils/previewRange.util.ts";
import {
  encryptFile,
  generateEncryptionKey,
} from "../src/utils/crypto.util.ts";

// Complete JPEG structure: extraction checks markers/dimensions, not pixels.
const jpeg = Uint8Array.from([
  255, 216, 255, 192, 0, 11, 8, 0, 48, 0, 64, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 42, 255, 217,
]);
function sourceOf(file) {
  const reads = [];
  return {
    reads,
    open: () =>
      createPreviewByteSource(async (start, end) => {
        reads.push([start, end]);
        return new Response(file.read(start, end + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
        });
      }),
  };
}
for (const little of [true, false])
  test(`extracts a distant DNG JPEG without its 100 MiB sensor data (${little ? "II" : "MM"})`, async () => {
    const file = rawPreviewFixture(jpeg, { little });
    const fixture = sourceOf(file);
    const preview = await readRawRangePreview(await fixture.open());
    assert.equal(preview.kind, "jpeg");
    assert.deepEqual(preview.decoded.bytes, jpeg);
    assert.equal(preview.decoded.orientation, 6);
    const bytes = fixture.reads.reduce((n, [a, b]) => n + b - a + 1, 0);
    assert.ok(bytes <= 128 * 1024 + 1);
    console.log(`DNG ${file.size} bytes: ${bytes} bytes read for its preview`);
  });

test("extracts an encrypted DNG preview using only authenticated metadata/image records", async () => {
  const file = rawPreviewFixture(jpeg);
  const key = await generateEncryptionKey();
  const recordSize = 1_000_000,
    storedRecordSize = recordSize + 28;
  const storedSize = file.size + Math.ceil(file.size / recordSize) * 28;
  const records = new Map(),
    reads = [];
  const source = await createPreviewByteSource(async (start, end) => {
    reads.push([start, end]);
    const bytes = new Uint8Array(end - start + 1);
    for (let pos = start; pos <= end; ) {
      const index = Math.floor(pos / storedRecordSize);
      if (!records.has(index))
        records.set(
          index,
          new Uint8Array(
            await encryptFile(
              file.read(
                index * recordSize,
                Math.min(file.size, (index + 1) * recordSize),
              ).buffer,
              key,
            ),
          ),
        );
      const record = records.get(index),
        within = pos - index * storedRecordSize,
        length = Math.min(end - pos + 1, record.length - within);
      bytes.set(record.subarray(within, within + length), pos - start);
      pos += length;
    }
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${storedSize}`,
        "X-Encryption-Chunk-Size": String(recordSize),
      },
    });
  }, key);
  const preview = await readRawRangePreview(source);
  assert.deepEqual(preview.decoded.bytes, jpeg);
  assert.ok(reads.length <= 3);
  assert.ok(reads.reduce((n, [a, b]) => n + b - a + 1, 0) <= 2_000_057);
});

test("rebases a non-JPEG RGB preview into a standalone TIFF and preserves orientation", async () => {
  const pixels = new Uint8Array(64 * 48 * 3).fill(37);
  const fixture = sourceOf(
    rawPreviewFixture(pixels, { jpeg: false, little: false }),
  );
  const preview = await readRawRangePreview(await fixture.open());
  assert.equal(preview.kind, "tiff");
  assert.ok(preview.bytes.byteLength < 10000);
  const bytes = new Uint8Array(preview.bytes),
    view = new DataView(preview.bytes);
  const count = view.getUint16(8, false);
  for (let i = 0; i < count; i++) {
    const at = 10 + i * 12,
      id = view.getUint16(at, false);
    if (id === 273) {
      const offset = view.getUint32(at + 8, false);
      assert.deepEqual(bytes.slice(offset), pixels);
    }
    if (id === 274) assert.equal(view.getUint16(at + 8, false), 6);
    assert.ok(id !== 330, "no pointer back into the sensor file");
  }
});

test("refuses out-of-bounds metadata and bounded directory floods without fetching sensor data", async () => {
  const file = rawPreviewFixture(jpeg);
  new DataView(file.metadata.buffer).setUint32(4, file.size - 1, true);
  const fixture = sourceOf(file);
  await assert.rejects(
    readRawRangePreview(await fixture.open()),
    /Invalid RAW preview range/,
  );
  assert.ok(fixture.reads.length <= 2);
  const flood = rawPreviewFixture(jpeg);
  new DataView(flood.metadata.buffer).setUint16(8, 65535, true);
  const floodSource = sourceOf(flood);
  await assert.rejects(
    readRawRangePreview(await floodSource.open()),
    /Too many RAW directory entries/,
  );
  assert.ok(floodSource.reads.length <= 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readRawRangePreview(
      { size: 100, read: () => assert.fail("aborted read") },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

test("does not treat CFA sensor strips as RGB previews", async () => {
  const file = rawPreviewFixture(jpeg);
  const view = new DataView(file.metadata.buffer);
  for (let i = 0; i < view.getUint16(512, true); i++) {
    const at = 514 + i * 12;
    if (view.getUint16(at, true) === 262) view.setUint16(at + 8, 32803, true);
  }
  const fixture = sourceOf(file);
  assert.equal(await readRawRangePreview(await fixture.open()), null);
  assert.ok(fixture.reads.every(([start]) => start < 65536));
});
