import {
  findLargestEmbeddedJpeg,
  MAX_DECODED_PIXELS,
  type DecodedStillImage,
} from "./imageDecoderCore.util";
import { readPreviewBytes, type PreviewByteSource } from "./previewRange.util";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_IFDS = 32;
const TYPE_BYTES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};
// Only image metadata is copied into the standalone preview. Private IFDs,
// sensor metadata, scripts and links to other directories are never copied.
const IMAGE_TAGS = new Set([
  254, 256, 257, 258, 259, 262, 266, 273, 274, 277, 278, 279, 282, 283, 284,
  296, 317, 320, 322, 323, 324, 325, 338, 339, 347, 529, 530, 531, 532, 34675,
]);
const DIRECTORY_TAGS = new Set([330, 34665]);
type Tag = {
  id: number;
  type: number;
  count: number;
  bytes: Uint8Array<ArrayBuffer>;
};
type Candidate = {
  tags: Map<number, Tag>;
  offsets: number[];
  lengths: number[];
  jpeg: boolean;
  area: number;
  orientation: number;
};
export type RawRangePreview =
  | { kind: "jpeg"; decoded: Extract<DecodedStillImage, { kind: "jpeg" }> }
  | { kind: "tiff"; bytes: ArrayBuffer };

/** Read the camera preview by its TIFF offsets, leaving the RAW sensor data alone. */
export async function readRawRangePreview(
  source: PreviewByteSource,
  signal?: AbortSignal,
): Promise<RawRangePreview | null> {
  let metadataBytes = 0;
  const read = async (start: number, length: number, metadata = true) => {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 1 ||
      start + length > source.size
    )
      throw new Error("Invalid RAW preview range");
    if (metadata && (metadataBytes += length) > MAX_METADATA_BYTES)
      throw new Error("RAW metadata exceeds preview budget");
    if (length > MAX_PREVIEW_BYTES)
      throw new Error("RAW preview exceeds memory budget");
    return readPreviewBytes(source, start, start + length, signal);
  };
  if (source.size < 8) return null;
  const header = await read(0, 8);
  const little = header[0] === 0x49 && header[1] === 0x49;
  if (!little && !(header[0] === 0x4d && header[1] === 0x4d)) return null;
  const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view(header).getUint16(2, little) !== 42) return null;
  const numbers = (tag?: Tag): number[] => {
    if (!tag || ![1, 3, 4, 13].includes(tag.type)) return [];
    const data = view(tag.bytes);
    return Array.from({ length: tag.count }, (_, i) =>
      tag.type === 1
        ? data.getUint8(i)
        : tag.type === 3
          ? data.getUint16(i * 2, little)
          : data.getUint32(i * 4, little),
    );
  };
  const pending = [view(header).getUint32(4, little)];
  const visited = new Set<number>();
  const candidates: Candidate[] = [];
  let orientation = 1;
  while (pending.length) {
    signal?.throwIfAborted();
    const offset = pending.shift()!;
    if (!offset || visited.has(offset)) continue;
    if (visited.size >= MAX_IFDS) throw new Error("Too many RAW directories");
    visited.add(offset);
    const count = view(await read(offset, 2)).getUint16(0, little);
    if (count > 512) throw new Error("Too many RAW directory entries");
    const directory = await read(offset + 2, count * 12 + 4);
    const table = view(directory);
    const tags = new Map<number, Tag>();
    for (let i = 0; i < count; i++) {
      const at = i * 12;
      const id = table.getUint16(at, little);
      if (
        !IMAGE_TAGS.has(id) &&
        !DIRECTORY_TAGS.has(id) &&
        id !== 513 &&
        id !== 514
      )
        continue;
      if (tags.has(id)) throw new Error("Duplicate RAW image tag");
      const type = table.getUint16(at + 2, little);
      const count = table.getUint32(at + 4, little);
      const size = TYPE_BYTES[type];
      if (!size || !count || count > 16384 || size * count > 65536)
        throw new Error("Invalid RAW tag length");
      const bytes =
        size * count <= 4
          ? directory.slice(at + 8, at + 8 + size * count)
          : await read(table.getUint32(at + 8, little), size * count);
      const tag = { id, type, count, bytes };
      tags.set(id, tag);
      if (DIRECTORY_TAGS.has(id)) {
        const children = numbers(tag);
        if (pending.length + children.length > MAX_IFDS)
          throw new Error("Too many RAW subdirectories");
        pending.push(...children);
      }
    }
    pending.push(table.getUint32(count * 12, little));
    const scalar = (id: number, fallback = 0) =>
      numbers(tags.get(id))[0] ?? fallback;
    const taggedOrientation = scalar(274, orientation);
    const upright =
      taggedOrientation >= 1 && taggedOrientation <= 8
        ? taggedOrientation
        : orientation;
    if (visited.size === 1) orientation = upright;
    const width = scalar(256),
      height = scalar(257),
      area = width * height;
    const jpegStart = scalar(513),
      jpegLength = scalar(514);
    if (jpegStart && jpegLength)
      candidates.push({
        tags,
        offsets: [jpegStart],
        lengths: [jpegLength],
        jpeg: true,
        area,
        orientation: upright,
      });
    const photometric = scalar(262, -1);
    if (
      photometric === 32803 ||
      photometric === 34892 ||
      !area ||
      area > MAX_DECODED_PIXELS
    )
      continue;
    const tiled = tags.has(324) && tags.has(325);
    const offsets = numbers(tags.get(tiled ? 324 : 273));
    const lengths = numbers(tags.get(tiled ? 325 : 279));
    if (
      !offsets.length ||
      offsets.length !== lengths.length ||
      offsets.length > 1024
    )
      continue;
    const compression = scalar(259, 1);
    if (![1, 5, 7, 8, 32773, 32946].includes(compression)) continue;
    candidates.push({
      tags,
      offsets,
      lengths,
      jpeg: compression === 7 && offsets.length === 1,
      area,
      orientation: upright,
    });
  }
  candidates.sort(
    (a, b) =>
      b.area - a.area ||
      b.lengths.reduce((n, x) => n + x, 0) -
        a.lengths.reduce((n, x) => n + x, 0),
  );
  let extractedBytes = 0;
  for (const candidate of candidates) {
    const total = candidate.lengths.reduce((n, length) => n + length, 0);
    if (
      total <= 0 ||
      total > MAX_PREVIEW_BYTES ||
      candidate.offsets.some(
        (offset, i) =>
          offset < 8 ||
          !candidate.lengths[i] ||
          offset + candidate.lengths[i] > source.size,
      )
    )
      continue;
    if (extractedBytes + total > MAX_PREVIEW_BYTES) break;
    extractedBytes += total;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < candidate.offsets.length; i++)
      parts.push(await read(candidate.offsets[i], candidate.lengths[i], false));
    if (candidate.jpeg) {
      const jpeg = findLargestEmbeddedJpeg(parts[0]);
      if (jpeg && jpeg.width * jpeg.height <= MAX_DECODED_PIXELS)
        return {
          kind: "jpeg",
          decoded: {
            kind: "jpeg",
            bytes: parts[0].slice(jpeg.start, jpeg.end),
            orientation:
              jpeg.exifOrientation === null ? candidate.orientation : 1,
          },
        };
      if (candidate.tags.has(513)) continue;
    }
    return { kind: "tiff", bytes: standaloneTiff(candidate, parts, little) };
  }
  return null;
}

function standaloneTiff(
  candidate: Candidate,
  parts: Uint8Array[],
  little: boolean,
): ArrayBuffer {
  const tags = new Map(
    [...candidate.tags].filter(([id]) => IMAGE_TAGS.has(id)),
  );
  const tiled = tags.has(324) && tags.has(325);
  const offsetTag = tiled ? 324 : 273;
  tags.delete(tiled ? 273 : 324);
  tags.delete(tiled ? 279 : 325);
  const longValues = (id: number, values: number[]): Tag => {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => view.setUint32(i * 4, value, little));
    return { id, type: 4, count: values.length, bytes };
  };
  tags.set(
    offsetTag,
    longValues(
      offsetTag,
      parts.map(() => 0),
    ),
  );
  // The container orientation also applies when the preview IFD omits its own.
  const upright = new Uint8Array(2);
  new DataView(upright.buffer).setUint16(0, candidate.orientation, little);
  tags.set(274, { id: 274, type: 3, count: 1, bytes: upright });
  const entries = [...tags.values()].sort((a, b) => a.id - b.id);
  let size = 8 + 2 + entries.length * 12 + 4;
  for (const tag of entries)
    if (tag.bytes.length > 4) size += tag.bytes.length + (tag.bytes.length % 2);
  const starts: number[] = [];
  for (const part of parts) {
    starts.push(size);
    size += part.length;
  }
  if (size > MAX_PREVIEW_BYTES + MAX_METADATA_BYTES)
    throw new Error("RAW preview exceeds memory budget");
  tags.set(offsetTag, longValues(offsetTag, starts));
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, entries.length, little);
  let extra = 8 + 2 + entries.length * 12 + 4;
  entries.forEach((original, i) => {
    const tag = tags.get(original.id)!;
    const at = 10 + i * 12;
    view.setUint16(at, tag.id, little);
    view.setUint16(at + 2, tag.type, little);
    view.setUint32(at + 4, tag.count, little);
    if (tag.bytes.length <= 4) bytes.set(tag.bytes, at + 8);
    else {
      view.setUint32(at + 8, extra, little);
      bytes.set(tag.bytes, extra);
      extra += tag.bytes.length + (tag.bytes.length % 2);
    }
  });
  parts.forEach((part, i) => bytes.set(part, starts[i]));
  return bytes.buffer;
}
