/**
 * Sample index of the tracks of an MP4 or QuickTime file, built from bounded
 * range reads: only box headers and the moov box are read, never the media
 * data. It lets the preview decode a codec the browser lacks (HEVC) on its
 * own, and hand the browser the sound alone.
 */

export type ReadBytes = (
  _start: number,
  _end: number,
  _signal?: AbortSignal,
) => Promise<Uint8Array>;

export type Mp4Samples = {
  count: number;
  /** Byte position in the file, in decoding order. */
  offset: Float64Array;
  size: Uint32Array;
  /** Presentation time in seconds. */
  time: Float64Array;
  /** Decoding time in units of the track timescale. */
  decode: Float64Array;
  /** 1 for a sample decoding can start from. */
  sync: Uint8Array;
};

export type Mp4VideoTrack = {
  /** Sample entry type: "hvc1", "hev1", "avc1"... */
  format: string;
  /** RFC 6381 codec for HEVC, such as "hvc1.1.6.L153.B0"; the format otherwise. */
  codec: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  /** HEVC only: size of the length prefix of each NAL unit. */
  nalLengthSize: number;
  /** HEVC only: VPS, SPS, PPS and SEI units of the hvcC box. */
  parameterSets: Uint8Array[];
  duration: number;
  samples: Mp4Samples;
};

export type Mp4AudioTrack = {
  /** Media Source type of the track, e.g. 'audio/mp4; codecs="mp4a.40.2"'. */
  mimeType: string;
  timescale: number;
  /** ISO "mp4a" sample entry with its esds box, as fragments declare it. */
  sampleEntry: Uint8Array;
  /** Seconds the edit list adds to the media timestamps. */
  shift: number;
  duration: number;
  samples: Mp4Samples;
};

export type Mp4Index = {
  duration: number;
  video: Mp4VideoTrack | null;
  /** The first sound track, when it is AAC or another MPEG-4 audio. */
  audio: Mp4AudioTrack | null;
  /** Any sound track, readable here or not. */
  hasAudio: boolean;
};

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4096;
const MAX_SAMPLES = 2_000_000;

export const HEVC_FORMATS = new Set(["hvc1", "hev1"]);

/** Readable names for the codecs a browser may lack. */
const CODEC_NAMES: Record<string, string> = {
  hvc1: "HEVC (H.265)",
  hev1: "HEVC (H.265)",
  avc1: "H.264",
  avc3: "H.264",
  av01: "AV1",
  vp09: "VP9",
  vp08: "VP8",
  mp4v: "MPEG-4 Part 2",
  s263: "H.263",
  h263: "H.263",
  apch: "Apple ProRes",
  apcn: "Apple ProRes",
  apcs: "Apple ProRes",
  apco: "Apple ProRes",
  ap4h: "Apple ProRes",
  ap4x: "Apple ProRes",
  dvh1: "Dolby Vision",
  dvhe: "Dolby Vision",
};

export const videoCodecName = (format: string) =>
  CODEC_NAMES[format] || format.trim().toUpperCase();

const fourcc = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

const fail = (reason: string): never => {
  throw new Error(`Unreadable MP4: ${reason}`);
};

type Box = { type: string; start: number; end: number };

/** Big-endian reads that fail on any access outside the bytes. */
class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private check(at: number, length: number) {
    if (at < 0 || at + length > this.bytes.length) fail("truncated box");
  }
  u8(at: number) {
    this.check(at, 1);
    return this.bytes[at];
  }
  u16(at: number) {
    this.check(at, 2);
    return this.view.getUint16(at);
  }
  u32(at: number) {
    this.check(at, 4);
    return this.view.getUint32(at);
  }
  i32(at: number) {
    this.check(at, 4);
    return this.view.getInt32(at);
  }
  u64(at: number) {
    this.check(at, 8);
    const value = this.view.getBigUint64(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("64-bit value");
    return Number(value);
  }
  i64(at: number) {
    this.check(at, 8);
    const value = this.view.getBigInt64(at);
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    )
      fail("64-bit value");
    return Number(value);
  }
  /** Entry count read at `at`, for a table that must fit in its box. */
  count(at: number, entryBytes: number, box: Box) {
    const count = this.u32(at);
    if (count > (box.end - at - 4) / entryBytes) fail("table size");
    return count;
  }
}

/** Child boxes of [start, end): payload bounds, without the header. */
const childBoxes = (reader: Reader, start: number, end: number): Box[] => {
  const boxes: Box[] = [];
  for (let at = start; at + 8 <= end; ) {
    let size = reader.u32(at);
    const type = fourcc(reader.bytes, at + 4);
    let header = 8;
    if (size === 1) {
      size = reader.u64(at + 8);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) fail(`box ${type}`);
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
};

const find = (reader: Reader, box: Box | undefined, ...path: string[]) => {
  let current = box;
  for (const type of path) {
    if (!current) return undefined;
    current = childBoxes(reader, current.start, current.end).find(
      (child) => child.type === type,
    );
  }
  return current;
};

/** Version byte of a full box, and where its fields begin. */
const fullBox = (reader: Reader, box: Box) => ({
  version: reader.u8(box.start),
  at: box.start + 4,
});

const timescaleAndDuration = (reader: Reader, box: Box) => {
  const { version, at } = fullBox(reader, box);
  return version === 1
    ? { timescale: reader.u32(at + 16), duration: reader.u64(at + 20) }
    : { timescale: reader.u32(at + 8), duration: reader.u32(at + 12) };
};

const rotationOf = (reader: Reader, tkhd: Box | undefined) => {
  if (!tkhd) return 0;
  const { version, at } = fullBox(reader, tkhd);
  const matrix = at + (version === 1 ? 32 : 20) + 16;
  const a = reader.i32(matrix);
  const b = reader.i32(matrix + 4);
  const c = reader.i32(matrix + 12);
  const d = reader.i32(matrix + 16);
  const one = 0x10000;
  if (a === 0 && d === 0 && b === one && c === -one) return 90;
  if (a === -one && d === -one && b === 0 && c === 0) return 180;
  if (a === 0 && d === 0 && b === -one && c === one) return 270;
  return 0;
};

const parseHvcC = (reader: Reader, box: Box) => {
  const at = box.start;
  const nalLengthSize = (reader.u8(at + 21) & 3) + 1;
  if (nalLengthSize === 3) fail("NAL length size");
  const parameterSets: Uint8Array[] = [];
  let pos = at + 23;
  for (let arrays = reader.u8(at + 22); arrays > 0; arrays--) {
    const units = reader.u16(pos + 1);
    pos += 3;
    for (let unit = 0; unit < units; unit++) {
      const length = reader.u16(pos);
      if (pos + 2 + length > box.end) fail("hvcC");
      parameterSets.push(reader.bytes.slice(pos + 2, pos + 2 + length));
      pos += 2 + length;
    }
  }
  if (!parameterSets.length) fail("no parameter sets");
  return { nalLengthSize, parameterSets };
};

/** ISO/IEC 14496-15 annex E codec of an hvcC box, after the sample format. */
const hevcCodec = (reader: Reader, box: Box, format: string) => {
  const at = box.start;
  const profile = reader.u8(at + 1);
  let compatibility = reader.u32(at + 2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) {
    reversed = (reversed << 1) | (compatibility & 1);
    compatibility >>>= 1;
  }
  const constraints = Array.from({ length: 6 }, (_, i) =>
    reader.u8(at + 6 + i),
  );
  while (constraints.length && !constraints[constraints.length - 1])
    constraints.pop();
  return [
    format,
    ["", "A", "B", "C"][profile >> 6] + (profile & 31),
    (reversed >>> 0).toString(16).toUpperCase(),
    (profile & 32 ? "H" : "L") + reader.u8(at + 12),
    ...constraints.map((byte) => byte.toString(16).toUpperCase()),
  ].join(".");
};

/** Presentation offset of the first edit, in media seconds. */
const editOffset = (
  reader: Reader,
  elst: Box | undefined,
  movieTimescale: number,
  mediaTimescale: number,
) => {
  if (!elst) return 0;
  const { version, at } = fullBox(reader, elst);
  const entryBytes = version === 1 ? 20 : 12;
  let empty = 0;
  for (let i = 0, count = reader.count(at, entryBytes, elst); i < count; i++) {
    const entry = at + 4 + i * entryBytes;
    const duration = version === 1 ? reader.u64(entry) : reader.u32(entry);
    const mediaTime =
      version === 1 ? reader.i64(entry + 8) : reader.i32(entry + 4);
    if (mediaTime === -1) {
      empty += movieTimescale ? duration / movieTimescale : 0;
      continue;
    }
    return empty - mediaTime / mediaTimescale;
  }
  return empty;
};

const sampleTable = (
  reader: Reader,
  stbl: Box,
  timescale: number,
  shift: number,
  fileSize: number,
): Mp4Samples => {
  const box = (type: string) => find(reader, stbl, type);
  const stsz = box("stsz");
  const stz2 = box("stz2");
  const stsc = box("stsc");
  const chunks = box("stco") || box("co64");
  const stts = box("stts");
  if ((!stsz && !stz2) || !stsc || !chunks || !stts) fail("sample table");

  let count: number;
  let sizeAt: (_index: number) => number;
  if (stsz) {
    const { at } = fullBox(reader, stsz);
    const fixed = reader.u32(at);
    count = fixed ? reader.u32(at + 4) : reader.count(at + 4, 4, stsz);
    sizeAt = fixed ? () => fixed : (i) => reader.u32(at + 8 + i * 4);
  } else {
    const { at } = fullBox(reader, stz2!);
    const bits = reader.u8(at + 3);
    if (bits !== 4 && bits !== 8 && bits !== 16) fail("stz2 field size");
    count = reader.u32(at + 4);
    if (count * bits > (stz2!.end - at - 8) * 8) fail("stz2 size");
    sizeAt = (i) =>
      bits === 16
        ? reader.u16(at + 8 + i * 2)
        : bits === 8
          ? reader.u8(at + 8 + i)
          : (reader.u8(at + 8 + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15;
  }
  if (count > MAX_SAMPLES) fail("too many samples");

  const offset = new Float64Array(count);
  const size = new Uint32Array(count);
  const time = new Float64Array(count);
  const decode = new Float64Array(count);
  const sync = new Uint8Array(count);

  const chunkBox = fullBox(reader, chunks!);
  const wide = chunks!.type === "co64";
  const chunkCount = reader.count(chunkBox.at, wide ? 8 : 4, chunks!);
  const chunkOffset = (i: number) =>
    wide
      ? reader.u64(chunkBox.at + 4 + i * 8)
      : reader.u32(chunkBox.at + 4 + i * 4);
  const stscBox = fullBox(reader, stsc!);
  const runs = reader.count(stscBox.at, 12, stsc!);
  let sample = 0;
  for (let run = 0; run < runs && sample < count; run++) {
    const entry = stscBox.at + 4 + run * 12;
    const first = reader.u32(entry) - 1;
    const perChunk = reader.u32(entry + 4);
    const last = run + 1 < runs ? reader.u32(entry + 12) - 1 : chunkCount;
    if (first < 0 || last > chunkCount || last < first) fail("stsc");
    for (let chunk = first; chunk < last && sample < count; chunk++) {
      let position = chunkOffset(chunk);
      for (let n = 0; n < perChunk && sample < count; n++, sample++) {
        offset[sample] = position;
        size[sample] = sizeAt(sample);
        position += size[sample];
      }
    }
  }
  // A recording cut short keeps the samples written before the cut.
  let usable = 0;
  while (
    usable < sample &&
    size[usable] > 0 &&
    offset[usable] + size[usable] <= fileSize
  )
    usable++;

  const sttsBox = fullBox(reader, stts!);
  let dts = 0;
  for (
    let i = 0, n = 0, entries = reader.count(sttsBox.at, 8, stts!);
    i < entries && n < count;
    i++
  ) {
    const entry = sttsBox.at + 4 + i * 8;
    const delta = reader.u32(entry + 4);
    for (let k = reader.u32(entry); k > 0 && n < count; k--, n++) {
      decode[n] = dts;
      time[n] = dts;
      dts += delta;
    }
  }
  const ctts = box("ctts");
  if (ctts) {
    const { at } = fullBox(reader, ctts);
    // Version 0 offsets are unsigned in the standard, yet writers store
    // negative ones there too: read them as signed, like every demuxer.
    for (
      let i = 0, n = 0, entries = reader.count(at, 8, ctts);
      i < entries && n < count;
      i++
    ) {
      const entry = at + 4 + i * 8;
      const delta = reader.i32(entry + 4);
      for (let k = reader.u32(entry); k > 0 && n < count; k--, n++)
        time[n] += delta;
    }
  }
  for (let i = 0; i < count; i++) time[i] = time[i] / timescale + shift;

  const stss = box("stss");
  if (stss) {
    const { at } = fullBox(reader, stss);
    for (let i = 0, entries = reader.count(at, 4, stss); i < entries; i++) {
      const number = reader.u32(at + 4 + i * 4);
      if (number >= 1 && number <= count) sync[number - 1] = 1;
    }
  } else sync.fill(1);

  return {
    count: usable,
    offset: offset.subarray(0, usable),
    size: size.subarray(0, usable),
    time: time.subarray(0, usable),
    decode: decode.subarray(0, usable),
    sync: sync.subarray(0, usable),
  };
};

/** Size of an MPEG-4 descriptor, coded on up to four 7-bit bytes. */
const descriptor = (reader: Reader, at: number, tag: number) => {
  if (reader.u8(at) !== tag) fail(`descriptor ${tag}`);
  let size = 0;
  let pos = at + 1;
  for (let i = 0; i < 4; i++) {
    const byte = reader.u8(pos++);
    size = size * 128 + (byte & 127);
    if (!(byte & 128)) break;
  }
  return { start: pos, end: pos + size };
};

/** RFC 6381 codec of an esds box: "mp4a.40.2" for AAC-LC. */
const esdsCodec = (reader: Reader, esds: Box) => {
  const es = descriptor(reader, esds.start + 4, 3);
  const flags = reader.u8(es.start + 2);
  let at = es.start + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + reader.u8(at);
  if (flags & 0x20) at += 2;
  const config = descriptor(reader, at, 4);
  const objectType = reader.u8(config.start);
  let codec = `mp4a.${objectType.toString(16)}`;
  if (objectType === 0x40) {
    const info = descriptor(reader, config.start + 13, 5);
    let audioObjectType = reader.u8(info.start) >> 3;
    if (audioObjectType === 31)
      audioObjectType =
        32 +
        (((reader.u8(info.start) & 7) << 3) | (reader.u8(info.start + 1) >> 5));
    codec += `.${audioObjectType}`;
  }
  return codec;
};

/**
 * The first "mp4a" entry rewritten as a plain ISO one: QuickTime files add
 * fields after version 1 or 2 entries and may nest esds in a wave box.
 */
const audioEntry = (
  reader: Reader,
  entry: number,
  entryEnd: number,
  sampleRate: number,
) => {
  if (fourcc(reader.bytes, entry + 4) !== "mp4a") return null;
  const version = reader.u16(entry + 16);
  const children = entry + 36 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  let boxes = childBoxes(reader, children, entryEnd);
  const wave = boxes.find((child) => child.type === "wave");
  if (wave) boxes = childBoxes(reader, wave.start, wave.end);
  const esds = boxes.find((child) => child.type === "esds");
  if (!esds) return null;
  const esdsBytes = reader.bytes.subarray(esds.start - 8, esds.end);
  const sampleEntry = new Uint8Array(36 + esdsBytes.length);
  const view = new DataView(sampleEntry.buffer);
  view.setUint32(0, sampleEntry.length);
  sampleEntry.set([109, 112, 52, 97], 4); // "mp4a"
  view.setUint16(14, 1); // data reference index
  view.setUint16(24, version === 2 ? 2 : reader.u16(entry + 24) || 2);
  view.setUint16(26, 16); // sample size
  view.setUint32(32, sampleRate < 65536 ? sampleRate * 65536 : 0);
  sampleEntry.set(esdsBytes, 36);
  return {
    mimeType: `audio/mp4; codecs="${esdsCodec(reader, esds)}"`,
    sampleEntry,
  };
};

const parseMoov = (moov: Uint8Array, fileSize: number): Mp4Index => {
  const reader = new Reader(moov);
  const root = { type: "moov", start: 0, end: moov.length };
  if (find(reader, root, "mvex")) fail("fragmented files are not indexed");
  const mvhd = find(reader, root, "mvhd");
  if (!mvhd) fail("missing mvhd");
  const movie = timescaleAndDuration(reader, mvhd!);
  let video: Mp4VideoTrack | null = null;
  let audio: Mp4AudioTrack | null = null;
  let hasAudio = false;
  let duration = movie.timescale ? movie.duration / movie.timescale : 0;

  for (const trak of childBoxes(reader, root.start, root.end)) {
    if (trak.type !== "trak") continue;
    const mdia = find(reader, trak, "mdia");
    const hdlr = find(reader, mdia, "hdlr");
    const mdhd = find(reader, mdia, "mdhd");
    if (!hdlr || !mdhd) continue;
    const handler = fourcc(moov, hdlr.start + 8);
    if (handler === "soun") {
      if (hasAudio) continue;
      hasAudio = true;
    } else if (handler !== "vide" || video) continue;

    const stbl = find(reader, mdia, "minf", "stbl");
    const stsd = find(reader, stbl, "stsd");
    if (!stbl || !stsd) continue;
    const entry = stsd.start + 8;
    const format = fourcc(moov, entry + 4);
    const media = timescaleAndDuration(reader, mdhd);
    if (!media.timescale) fail("media timescale");
    const shift = editOffset(
      reader,
      find(reader, trak, "edts", "elst"),
      movie.timescale,
      media.timescale,
    );
    const entryEnd = entry + reader.u32(entry);
    if (entryEnd > stsd.end) fail("sample entry");
    if (handler === "soun") {
      const fragmentEntry = audioEntry(
        reader,
        entry,
        entryEnd,
        media.timescale,
      );
      if (fragmentEntry)
        audio = {
          ...fragmentEntry,
          timescale: media.timescale,
          shift,
          duration: media.duration / media.timescale,
          samples: sampleTable(reader, stbl, media.timescale, shift, fileSize),
        };
      continue;
    }
    let config = {
      codec: format,
      nalLengthSize: 0,
      parameterSets: [] as Uint8Array[],
    };
    if (HEVC_FORMATS.has(format)) {
      const hvcC = childBoxes(reader, entry + 86, entryEnd).find(
        (child) => child.type === "hvcC",
      );
      if (!hvcC) fail("missing hvcC");
      config = {
        codec: hevcCodec(reader, hvcC!, format),
        ...parseHvcC(reader, hvcC!),
      };
    }
    const samples = sampleTable(reader, stbl, media.timescale, shift, fileSize);
    const trackDuration = media.duration / media.timescale;
    duration = Math.max(duration, trackDuration);
    video = {
      format,
      width: reader.u16(entry + 32),
      height: reader.u16(entry + 34),
      rotation: rotationOf(reader, find(reader, trak, "tkhd")),
      ...config,
      duration: trackDuration,
      samples,
    };
  }
  return { duration, video, audio, hasAudio };
};

/** Reads the box headers then the moov box, wherever it sits in the file. */
export async function readMp4Index(
  read: ReadBytes,
  fileSize: number,
  signal?: AbortSignal,
): Promise<Mp4Index> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 16) fail("size");
  let at = 0;
  for (let boxes = 0; at + 8 <= fileSize; boxes++) {
    if (boxes >= MAX_TOP_LEVEL_BOXES) fail("too many boxes");
    signal?.throwIfAborted();
    const head = await read(at, Math.min(fileSize, at + 16), signal);
    const reader = new Reader(head);
    const type = fourcc(head, 4);
    let size = reader.u32(0);
    let header = 8;
    if (size === 1) {
      size = reader.u64(8);
      header = 16;
    } else if (size === 0) size = fileSize - at;
    if (size < header || at + size > fileSize) fail(`box ${type}`);
    if (type === "moof") fail("fragmented files are not indexed");
    if (type === "moov") {
      if (size - header > MAX_MOOV_BYTES) fail("moov size");
      const moov = new Uint8Array(size - header);
      for (let pos = 0; pos < moov.length; pos += MAX_READ_BYTES) {
        const start = at + header + pos;
        moov.set(
          await read(
            start,
            Math.min(at + size, start + MAX_READ_BYTES),
            signal,
          ),
          pos,
        );
      }
      return parseMoov(moov, fileSize);
    }
    at += size;
  }
  return fail("missing moov");
}

/** Last sample at or before `time` that decoding can start from. */
export function syncSampleBefore(samples: Mp4Samples, time: number) {
  let best = -1;
  for (let i = 0; i < samples.count; i++) {
    if (!samples.sync[i]) continue;
    if (best === -1 || samples.time[i] <= time) best = i;
    if (samples.time[i] > time) break;
  }
  return Math.max(best, 0);
}

/** First sample after `time` that decoding can start from, or -1. */
export function syncSampleAfter(samples: Mp4Samples, time: number) {
  for (let i = 0; i < samples.count; i++)
    if (samples.sync[i] && samples.time[i] > time) return i;
  return -1;
}
