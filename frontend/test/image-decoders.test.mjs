import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import {
  decodeStillImage,
  downscaleRgba,
  findLargestEmbeddedJpeg,
  MAX_DECODED_PIXELS,
  readTiffOrientation,
} from "../src/utils/imageDecoderCore.util.ts";
import {
  imageDecoderFormat,
  isPreviewableImageMimeType,
  orientationTransform,
} from "../src/utils/imageFormats.util.ts";
import {
  doesFileSupportPreview,
  resolveFileMimeType,
  sniffPreviewMimeType,
} from "../src/utils/filePreview.util.ts";
import { externalPreviewKind } from "../src/utils/externalPreviewLayout.util.ts";

const require = createRequire(import.meta.url);
const fixture = (name) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/images/${name}`, import.meta.url)),
  );

// The libraries are loaded the way the worker loads them: libheif from its
// glue and .wasm, UTIF as a script reading the global pako.
const heif = require("libheif-js/libheif-wasm/libheif.js")({
  wasmBinary: readFileSync(
    require.resolve("libheif-js/libheif-wasm/libheif.wasm"),
  ),
  print: () => {},
  printErr: () => {},
});
const utifContext = vm.createContext({});
// Inside the worker, self and window (set by loadTiff) are the global object.
vm.runInContext("self = this; window = this;", utifContext);
vm.runInContext(
  readFileSync(require.resolve("pako/dist/pako_inflate.min.js"), "utf8"),
  utifContext,
);
vm.runInContext(
  readFileSync(require.resolve("utif2/UTIF.js"), "utf8"),
  utifContext,
);
const libraries = {
  heif: async () => heif,
  tiff: async () => utifContext.UTIF,
};
const quietly = async (run) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
};
const decode = (format, bytes, maxSide = 4096) =>
  quietly(() => decodeStillImage(format, bytes, libraries, maxSide));

const pixel = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
};
const near = (actual, expected, tolerance = 24) =>
  assert.ok(
    actual.every(
      (value, index) => Math.abs(value - expected[index]) <= tolerance,
    ),
    `${actual} is not close to ${expected}`,
  );

// Quadrants of the fixtures: red, green / blue, white (translucent in alpha).
const RED = [220, 30, 30, 255];
const GREEN = [30, 200, 30, 255];
const BLUE = [30, 30, 220, 255];
const WHITE = [240, 240, 240, 255];
const assertQuadrants = (image, bottomRight = WHITE) => {
  assert.equal(image.kind, "rgba");
  assert.equal(image.width, 64);
  assert.equal(image.height, 48);
  near(pixel(image, 8, 8), RED);
  near(pixel(image, 56, 8), GREEN);
  near(pixel(image, 8, 40), BLUE);
  near(pixel(image, 56, 40), bottomRight);
};

// ---------------------------------------------------------------- formats --

test("routes each image format to the browser or to its decoder", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp", "image/avif"]) {
    assert.equal(imageDecoderFormat(type), null);
    assert.equal(isPreviewableImageMimeType(type), true);
  }
  assert.equal(imageDecoderFormat("image/heic"), "heif");
  assert.equal(imageDecoderFormat("IMAGE/HEIF; charset=binary"), "heif");
  assert.equal(imageDecoderFormat("image/tiff"), "tiff");
  assert.equal(imageDecoderFormat("image/x-canon-cr3"), "raw");
  for (const type of [
    "image/vnd.adobe.photoshop",
    "image/jp2",
    "image/x-tga",
  ]) {
    assert.equal(isPreviewableImageMimeType(type), false, type);
  }
});

test("names camera RAW files and offers previews only where one can render", () => {
  assert.equal(resolveFileMimeType("IMG_0001.CR2"), "image/x-canon-cr2");
  assert.equal(resolveFileMimeType("DSC.nef"), "image/x-nikon-nef");
  assert.equal(resolveFileMimeType("photo.HEIC"), "image/heic");
  for (const name of [
    "a.heic",
    "a.heif",
    "a.tif",
    "a.tiff",
    "a.dng",
    "a.arw",
  ]) {
    assert.equal(
      doesFileSupportPreview(name, { fileSizeBytes: 5_000_000 }),
      true,
      name,
    );
  }
  for (const name of ["a.psd", "a.jp2", "a.tga", "a.raw"]) {
    assert.equal(
      doesFileSupportPreview(name, { fileSizeBytes: 5_000_000 }),
      false,
      name,
    );
  }
  // RAW previews have bounded range reads even when their sensor data is large.
  assert.equal(
    doesFileSupportPreview("big.dng", { fileSizeBytes: 121 * 1024 * 1024 }),
    true,
  );
  assert.equal(
    doesFileSupportPreview("big.jpg", { fileSizeBytes: 121 * 1024 * 1024 }),
    true,
  );
  assert.equal(externalPreviewKind("image/heic"), "image");
  assert.equal(externalPreviewKind("image/vnd.adobe.photoshop"), null);
});

const ftyp = (...brands) => {
  const bytes = new Uint8Array(8 + brands.length * 4);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode("ftyp" + brands.join("")), 4);
  return bytes;
};

test("recognises HEIF, AVIF and CR3 by their brands instead of calling them MP4", () => {
  assert.equal(sniffPreviewMimeType(fixture("quadrants.heic")), "image/heic");
  assert.equal(
    sniffPreviewMimeType(ftyp("heic", "\0\0\0\0", "mif1", "heic")),
    "image/heic",
  );
  assert.equal(
    sniffPreviewMimeType(ftyp("mif1", "\0\0\0\0", "mif1", "heic")),
    "image/heic",
  );
  assert.equal(
    sniffPreviewMimeType(ftyp("mif1", "\0\0\0\0", "mif1", "avif")),
    "image/avif",
  );
  assert.equal(
    sniffPreviewMimeType(ftyp("mif1", "\0\0\0\0", "mif1")),
    "image/heif",
  );
  assert.equal(
    sniffPreviewMimeType(ftyp("crx ", "\x00\x00\x00\x01", "crx ", "isom")),
    "image/x-canon-cr3",
  );
  assert.equal(
    sniffPreviewMimeType(ftyp("isom", "\x00\x00\x02\x00", "isom", "mp41")),
    "video/mp4",
  );
  assert.equal(
    sniffPreviewMimeType(fixture("quadrants-lzw.tif")),
    "image/tiff",
  );
  const ascii = (text) => new TextEncoder().encode(text.padEnd(32, "\0"));
  assert.equal(sniffPreviewMimeType(ascii("IIRO\x08")), "image/x-olympus-orf");
  assert.equal(
    sniffPreviewMimeType(ascii("IIU\0\x08")),
    "image/x-panasonic-rw2",
  );
  assert.equal(
    sniffPreviewMimeType(ascii("FUJIFILMCCD-RAW 0201")),
    "image/x-fuji-raf",
  );
});

test("orientation transforms draw every Exif orientation upright", () => {
  // A 3x2 image whose pixel (x, y) must land where the Exif definition says.
  const expected = {
    1: (x, y) => [x, y],
    2: (x, y) => [2 - x, y],
    3: (x, y) => [2 - x, 1 - y],
    4: (x, y) => [x, 1 - y],
    5: (x, y) => [y, x],
    6: (x, y) => [1 - y, x],
    7: (x, y) => [1 - y, 2 - x],
    8: (x, y) => [y, 2 - x],
  };
  for (const [orientation, place] of Object.entries(expected)) {
    const { width, height, matrix } = orientationTransform(
      Number(orientation),
      3,
      2,
    );
    const [a, b, c, d, e, f] = matrix;
    assert.deepEqual(
      [width, height],
      Number(orientation) >= 5 ? [2, 3] : [3, 2],
    );
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        // Map the pixel's centre, then take the destination pixel it covers.
        const cx = x + 0.5;
        const cy = y + 0.5;
        const target = [
          Math.floor(a * cx + c * cy + e),
          Math.floor(b * cx + d * cy + f),
        ];
        assert.deepEqual(target, place(x, y), `orientation ${orientation}`);
      }
    }
  }
});

// ------------------------------------------------------------------- HEIF --

test("decodes a HEIC photo and keeps its transparency", async () => {
  assertQuadrants(await decode("heif", fixture("quadrants.heic")));
  const translucent = await decode("heif", fixture("quadrants-alpha.heic"));
  assertQuadrants(translucent, [240, 240, 240, 96]);
  assert.equal(translucent.hasAlpha, true);
  assert.equal(translucent.orientation, 1);
});

test("downscales a decoded image to the requested size", async () => {
  const small = await decode("heif", fixture("quadrants.heic"), 32);
  assert.deepEqual([small.width, small.height], [32, 24]);
  near(pixel(small, 4, 4), RED);
  near(pixel(small, 28, 20), WHITE);

  const data = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255]);
  const { data: averaged, width, height } = downscaleRgba(data, 2, 1, 1);
  assert.deepEqual([width, height], [1, 1]);
  assert.deepEqual([...averaged], [100, 50, 25, 255]);
});

test("rejects HEIF files without a still image and corrupt input", async () => {
  await assert.rejects(decode("heif", ftyp("msf1", "\0\0\0\0", "msf1")));
  await assert.rejects(
    decode("heif", fixture("quadrants.heic").subarray(0, 300)),
  );
});

// ------------------------------------------------------------------- TIFF --

test("decodes TIFF compressions, depths and colour models", async () => {
  for (const name of [
    "quadrants-lzw.tif",
    "quadrants-deflate.tif",
    "quadrants-packbits.tif",
    "quadrants-jpeg.tif",
    "quadrants-16bit.tif",
    "quadrants-cmyk.tif",
  ]) {
    const image = await decode("tiff", fixture(name));
    assertQuadrants(image);
    assert.equal(image.hasAlpha, false, name);
  }
  const gray = await decode("tiff", fixture("quadrants-gray.tif"));
  assert.equal(gray.width, 64);
  assert.ok(pixel(gray, 8, 8)[0] < pixel(gray, 56, 40)[0]);
});

test("shows the first page of a TIFF with its alpha and orientation", async () => {
  assertQuadrants(await decode("tiff", fixture("quadrants-multipage.tif")));
  const alpha = await decode("tiff", fixture("quadrants-alpha.tif"));
  assertQuadrants(alpha, [240, 240, 240, 96]);
  assert.equal(alpha.hasAlpha, true);
  const rotated = await decode("tiff", fixture("quadrants-orientation6.tif"));
  assert.equal(rotated.orientation, 6);
  assert.equal(readTiffOrientation(fixture("quadrants-orientation6.tif")), 6);
  assert.equal(readTiffOrientation(fixture("quadrants-lzw.tif")), 1);
});

// -------------------------------------------------------------------- RAW --

// A structurally complete JPEG: the decoder walks markers, it does not decode.
const jpeg = (
  width,
  height,
  { sof = 0xc0, exifOrientation, fill = 0x55 } = {},
) => {
  const parts = [[0xff, 0xd8]];
  if (exifOrientation) {
    const tiff = [
      0x4d,
      0x4d,
      0,
      42,
      0,
      0,
      0,
      8,
      0,
      1,
      1,
      18,
      0,
      3,
      0,
      0,
      0,
      1,
      0,
      exifOrientation,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    const payload = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
    parts.push([
      0xff,
      0xe1,
      (payload.length + 2) >> 8,
      (payload.length + 2) & 255,
      ...payload,
    ]);
  }
  parts.push([
    0xff,
    sof,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
  parts.push([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
  // Entropy data with a stuffed 0xFF00 and a restart marker.
  parts.push([fill, 0xff, 0x00, fill, 0xff, 0xd0, fill, 0xff, 0xd9]);
  return Uint8Array.from(parts.flat());
};
const concat = (...chunks) => {
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
const noise = (length, seed = 7) => {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[index] = seed >>> 24;
  }
  // Fake markers sensor data contains by chance: none forms a whole JPEG.
  out.set([0xff, 0xd8, 0xff, 0xc4, 0xff, 0xff], 100);
  return out;
};

test("finds the largest complete preview JPEG, even one ending the file", () => {
  const thumbnail = jpeg(160, 120);
  const preview = jpeg(6000, 4000);
  const lossless = jpeg(7000, 5000, { sof: 0xc3 });
  const file = concat(
    noise(400),
    thumbnail,
    noise(300, 3),
    lossless,
    noise(200, 5),
    preview,
  );
  const found = findLargestEmbeddedJpeg(file);
  assert.deepEqual([found.width, found.height], [6000, 4000]);
  assert.equal(found.end, file.length);
  assert.deepEqual(file.subarray(found.start, found.end), preview);
  assert.equal(findLargestEmbeddedJpeg(noise(5000)), null);
  // Truncated: no EOI.
  assert.equal(
    findLargestEmbeddedJpeg(preview.subarray(0, preview.length - 2)),
    null,
  );
});

// Minimal TIFF: IFD0 = sensor data (CFA) with orientation, optional SubIFD.
const rawTiff = ({ orientation = 1, preview } = {}) => {
  const entries = [
    [256, 3, 1, 4000],
    [257, 3, 1, 3000],
    [262, 3, 1, 32803],
    [274, 3, 1, orientation],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const bytes = new Uint8Array(8 + ifdSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], index) => {
    const at = 10 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    view.setUint16(at + 8, value, true);
  });
  return preview ? concat(bytes, noise(256, 11), preview) : bytes;
};

test("previews a RAW file with its camera JPEG and the camera's orientation", async () => {
  const preview = jpeg(4000, 3000);
  const upright = await decode("raw", rawTiff({ orientation: 8, preview }));
  assert.equal(upright.kind, "jpeg");
  assert.deepEqual(upright.bytes, preview);
  assert.equal(upright.orientation, 8);

  // An Exif orientation inside the JPEG is the browser's to apply.
  const tagged = jpeg(4000, 3000, { exifOrientation: 6 });
  const own = await decode("raw", rawTiff({ orientation: 8, preview: tagged }));
  assert.equal(own.orientation, 1);

  // Non-TIFF containers (CR3, RAF) carry it too.
  const container = concat(
    ftyp("crx ", "\x00\x00\x00\x01", "crx "),
    noise(512),
    preview,
  );
  assert.equal((await decode("raw", container)).kind, "jpeg");
});

test("a TIFF holding only sensor data falls back to its embedded preview", async () => {
  const preview = jpeg(3000, 2000);
  const result = await decode("tiff", rawTiff({ preview }));
  assert.equal(result.kind, "jpeg");
  await assert.rejects(decode("raw", rawTiff()), /No preview/);
});

test("refuses dimensions a phone cannot hold", async () => {
  assert.ok(MAX_DECODED_PIXELS >= 48_000_000, "a 48 MP iPhone photo must fit");
  await assert.rejects(
    decode("heif", fixture("quadrants.heic"), 0),
    /Invalid preview size/,
  );
  await assert.rejects(
    decode("bmp", fixture("quadrants.heic")),
    /Unsupported image format/,
  );
});
