// Still-image decoding for formats browsers cannot display: HEIC/HEIF, TIFF
// and camera RAW. Runs inside public/image-decoders/decoder.worker.js, which
// receives this file transpiled by scripts/build-image-decoders.mjs, so it
// must stay free of imports and DOM APIs. The decoders are injected.

export type ImageDecoderFormat = "heif" | "tiff" | "raw";

/** A JPEG the browser decodes itself, or pixels to draw on a canvas. */
export type DecodedStillImage =
  | { kind: "jpeg"; bytes: Uint8Array; orientation: number }
  | {
      kind: "rgba";
      width: number;
      height: number;
      data: Uint8ClampedArray;
      hasAlpha: boolean;
      orientation: number;
    };

type HeifImage = {
  get_width: () => number;
  get_height: () => number;
  is_primary: () => boolean;
  has_alpha_channel: () => boolean;
  display: (
    _target: { data: Uint8ClampedArray; width: number; height: number },
    _done: (_result: unknown) => void,
  ) => void;
  free: () => void;
};
export type HeifLibrary = {
  HeifDecoder: new () => {
    decoder: unknown;
    decode: (_bytes: Uint8Array) => HeifImage[];
  };
  heif_context_free: (_context: unknown) => void;
};

type TiffIfd = Record<string, unknown> & {
  width?: number;
  height?: number;
  subIFD?: TiffIfd[];
};
export type TiffLibrary = {
  decode: (_buffer: ArrayBuffer) => TiffIfd[];
  decodeImage: (_buffer: ArrayBuffer, _ifd: TiffIfd) => void;
  toRGBA8: (_ifd: TiffIfd) => Uint8Array;
};

export type ImageDecoderLibraries = {
  heif: () => Promise<HeifLibrary>;
  tiff: () => Promise<TiffLibrary>;
};

/** Beyond this, a phone runs out of memory before the preview appears. */
export const MAX_DECODED_PIXELS = 64 * 1024 * 1024;

const TIFF_CFA = 32803;
const TIFF_LINEAR_RAW = 34892;
const JPEG_BASELINE_SOF = new Set([0xc0, 0xc1, 0xc2]);
// Below this, a RAW's embedded JPEG is a thumbnail and its TIFF previews are
// worth decoding instead.
const RAW_THUMBNAIL_PIXELS = 1024 * 768;

const readU16 = (bytes: Uint8Array, offset: number, little: boolean) =>
  little
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];

const readU32 = (bytes: Uint8Array, offset: number, little: boolean) =>
  little
    ? (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0
    : ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0;

const validOrientation = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= 8 ? value : 1;

/** Orientation tag (274) of the first IFD of a TIFF structure, if present. */
function findTiffOrientation(
  bytes: Uint8Array,
  start: number,
  end: number,
): number | null {
  if (start < 0 || end > bytes.length || end - start < 8) return null;
  const order = String.fromCharCode(bytes[start], bytes[start + 1]);
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  const ifd = start + readU32(bytes, start + 4, little);
  if (ifd < start + 8 || ifd + 2 > end) return null;
  const count = readU16(bytes, ifd, little);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return null;
    if (readU16(bytes, entry, little) === 274) {
      return validOrientation(readU16(bytes, entry + 8, little));
    }
  }
  return null;
}

/** Orientation of a TIFF-based file such as most RAW formats, 1 by default. */
export const readTiffOrientation = (bytes: Uint8Array): number =>
  findTiffOrientation(bytes, 0, bytes.length) ?? 1;

type EmbeddedJpeg = {
  start: number;
  end: number;
  width: number;
  height: number;
  exifOrientation: number | null;
};

/** Walk one JPEG from its SOI marker. Null unless it is complete and sane. */
function walkJpeg(bytes: Uint8Array, start: number): EmbeddedJpeg | null {
  let offset = start + 2;
  let width = 0;
  let height = 0;
  let frame = -1;
  let exifOrientation: number | null = null;
  for (;;) {
    if (offset + 2 > bytes.length || bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (frame < 0 || width === 0 || height === 0) return null;
      return { start, end: offset, width, height, exifOrientation };
    }
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return null;
    const length = readU16(bytes, offset, false);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (length < 8) return null;
      frame = marker;
      height = readU16(bytes, offset + 3, false);
      width = readU16(bytes, offset + 5, false);
      if (!JPEG_BASELINE_SOF.has(marker)) return null;
    } else if (
      marker === 0xe1 &&
      exifOrientation === null &&
      length >= 16 &&
      String.fromCharCode(...bytes.subarray(offset + 2, offset + 6)) === "Exif"
    ) {
      exifOrientation = findTiffOrientation(bytes, offset + 8, offset + length);
    }
    offset += length;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is neither a stuffed
      // 0xFF00, a restart marker nor fill bytes.
      for (;;) {
        if (offset + 1 >= bytes.length) return null;
        const next = bytes[offset + 1];
        if (
          bytes[offset] === 0xff &&
          next !== 0 &&
          next !== 0xff &&
          !(next >= 0xd0 && next <= 0xd7)
        )
          break;
        offset++;
      }
    }
  }
}

/**
 * Largest complete baseline or progressive JPEG stored anywhere in the file.
 * Every RAW format keeps one as its camera preview, and walking the markers
 * rejects the random 0xFFD8FF sequences of compressed sensor data.
 */
export function findLargestEmbeddedJpeg(
  bytes: Uint8Array,
): EmbeddedJpeg | null {
  let best: EmbeddedJpeg | null = null;
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (
      bytes[index] !== 0xff ||
      bytes[index + 1] !== 0xd8 ||
      bytes[index + 2] !== 0xff
    )
      continue;
    const found = walkJpeg(bytes, index);
    if (!found) continue;
    if (!best || found.width * found.height > best.width * best.height) {
      best = found;
    }
    // Thumbnails nested in this JPEG's Exif block are never larger than it.
    index = found.end - 1;
  }
  return best;
}

/** Box-filter downscale so the longest side fits maxSide. */
export function downscaleRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxSide: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { data, width, height };
  const scale = maxSide / longest;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const target = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const top = Math.floor((y * height) / targetHeight);
    const bottom = Math.max(
      top + 1,
      Math.floor(((y + 1) * height) / targetHeight),
    );
    for (let x = 0; x < targetWidth; x++) {
      const left = Math.floor((x * width) / targetWidth);
      const right = Math.max(
        left + 1,
        Math.floor(((x + 1) * width) / targetWidth),
      );
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let row = top; row < bottom; row++) {
        let source = (row * width + left) * 4;
        for (let column = left; column < right; column++) {
          r += data[source];
          g += data[source + 1];
          b += data[source + 2];
          a += data[source + 3];
          source += 4;
        }
      }
      const count = (bottom - top) * (right - left);
      const out = (y * targetWidth + x) * 4;
      target[out] = r / count;
      target[out + 1] = g / count;
      target[out + 2] = b / count;
      target[out + 3] = a / count;
    }
  }
  return { data: target, width: targetWidth, height: targetHeight };
}

const hasTransparency = (data: Uint8ClampedArray) => {
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) return true;
  }
  return false;
};

function rgbaResult(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxSide: number,
  orientation: number,
): DecodedStillImage {
  const scaled = downscaleRgba(data, width, height, maxSide);
  return {
    kind: "rgba",
    ...scaled,
    hasAlpha: hasTransparency(scaled.data),
    orientation,
  };
}

const assertDecodableSize = (width: number, height: number) => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_DECODED_PIXELS
  ) {
    throw new Error("Unsupported image dimensions");
  }
};

/** Primary image of a HEIC/HEIF file, with its rotation and mirror applied. */
export async function decodeHeif(
  library: HeifLibrary,
  bytes: Uint8Array,
  maxSide: number,
): Promise<DecodedStillImage> {
  const decoder = new library.HeifDecoder();
  let images: HeifImage[] = [];
  try {
    images = decoder.decode(bytes);
    const image =
      images.find((candidate) => candidate.is_primary()) ?? images[0];
    if (!image) throw new Error("No still image in this HEIF file");
    const width = image.get_width();
    const height = image.get_height();
    assertDecodableSize(width, height);
    const data = new Uint8ClampedArray(width * height * 4);
    const decoded = await new Promise<unknown>((resolve) =>
      image.display({ data, width, height }, resolve),
    );
    if (!decoded) throw new Error("HEIF decoding failed");
    return rgbaResult(data, width, height, maxSide, 1);
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) library.heif_context_free(decoder.decoder);
  }
}

const tag = (ifd: TiffIfd, id: number): number | undefined => {
  const value = ifd["t" + id];
  return Array.isArray(value) && typeof value[0] === "number"
    ? value[0]
    : undefined;
};

const isSensorData = (ifd: TiffIfd) => {
  const photometric = tag(ifd, 262);
  return photometric === TIFF_CFA || photometric === TIFF_LINEAR_RAW;
};

const ifdArea = (ifd: TiffIfd) => (tag(ifd, 256) ?? 0) * (tag(ifd, 257) ?? 0);

function flattenIfds(ifds: TiffIfd[]): TiffIfd[] {
  const all: TiffIfd[] = [];
  const visit = (list: TiffIfd[] | undefined) => {
    for (const ifd of list ?? []) {
      all.push(ifd);
      visit(ifd.subIFD);
    }
  };
  visit(ifds);
  return all;
}

function decodeTiffIfd(
  library: TiffLibrary,
  buffer: ArrayBuffer,
  ifd: TiffIfd,
  maxSide: number,
  orientation: number,
): DecodedStillImage {
  assertDecodableSize(tag(ifd, 256) ?? 0, tag(ifd, 257) ?? 0);
  library.decodeImage(buffer, ifd);
  const width = ifd.width ?? 0;
  const height = ifd.height ?? 0;
  assertDecodableSize(width, height);
  const rgba = library.toRGBA8(ifd);
  if (rgba.length !== width * height * 4) {
    throw new Error("TIFF decoding failed");
  }
  const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
  // Only ExtraSamples (338) declares an alpha channel. Without it, UTIF's
  // CMYK conversion still reads one sample past the data for the last pixel.
  const extraSamples = ifd.t338;
  if (
    !Array.isArray(extraSamples) ||
    !extraSamples.some((value) => value === 1 || value === 2)
  ) {
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
  }
  return rgbaResult(data, width, height, maxSide, orientation);
}

const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);

function parseTiff(library: TiffLibrary, buffer: ArrayBuffer): TiffIfd[] {
  try {
    return library.decode(buffer);
  } catch {
    return [];
  }
}

/** First page of a TIFF; a DNG saved as .tif falls back to the RAW path. */
export async function decodeTiff(
  libraries: ImageDecoderLibraries,
  bytes: Uint8Array,
  maxSide: number,
): Promise<DecodedStillImage> {
  const library = await libraries.tiff();
  const buffer = bufferOf(bytes);
  const pages = parseTiff(library, buffer);
  const page = pages.find(
    (ifd) => !isSensorData(ifd) && ((tag(ifd, 254) ?? 0) & 1) === 0,
  );
  if (!page) return decodeRaw(libraries, bytes, maxSide);
  return decodeTiffIfd(
    library,
    buffer,
    page,
    maxSide,
    readTiffOrientation(bytes),
  );
}

/**
 * The camera's own preview: its largest embedded JPEG, or else the largest
 * TIFF image of the file that is not sensor data (uncompressed DNG previews).
 */
export async function decodeRaw(
  libraries: ImageDecoderLibraries,
  bytes: Uint8Array,
  maxSide: number,
): Promise<DecodedStillImage> {
  const orientation = readTiffOrientation(bytes);
  const jpeg = findLargestEmbeddedJpeg(bytes);
  const jpegArea = jpeg ? jpeg.width * jpeg.height : 0;
  if (jpeg && jpegArea >= RAW_THUMBNAIL_PIXELS) {
    return jpegResult(bytes, jpeg, orientation);
  }
  const library = await libraries.tiff();
  const buffer = bufferOf(bytes);
  const preview = flattenIfds(parseTiff(library, buffer))
    .filter((ifd) => !isSensorData(ifd) && ifdArea(ifd) > jpegArea)
    .sort((a, b) => ifdArea(b) - ifdArea(a))[0];
  if (preview) {
    try {
      return decodeTiffIfd(library, buffer, preview, maxSide, orientation);
    } catch (error) {
      if (!jpeg) throw error;
    }
  }
  if (jpeg) return jpegResult(bytes, jpeg, orientation);
  throw new Error("No preview in this RAW file");
}

function jpegResult(
  bytes: Uint8Array,
  jpeg: EmbeddedJpeg,
  containerOrientation: number,
): DecodedStillImage {
  return {
    kind: "jpeg",
    bytes: bytes.slice(jpeg.start, jpeg.end),
    // The browser already applies an Exif orientation carried by the JPEG.
    orientation: jpeg.exifOrientation === null ? containerOrientation : 1,
  };
}

export async function decodeStillImage(
  format: ImageDecoderFormat,
  bytes: Uint8Array,
  libraries: ImageDecoderLibraries,
  maxSide: number,
): Promise<DecodedStillImage> {
  if (!Number.isSafeInteger(maxSide) || maxSide < 1) {
    throw new Error("Invalid preview size");
  }
  if (format === "heif") {
    return decodeHeif(await libraries.heif(), bytes, maxSide);
  }
  if (format === "tiff") return decodeTiff(libraries, bytes, maxSide);
  if (format === "raw") return decodeRaw(libraries, bytes, maxSide);
  throw new Error("Unsupported image format");
}
