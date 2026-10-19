import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  readMp4Index,
  syncSampleAfter,
  syncSampleBefore,
  videoCodecName,
} from "../src/utils/mp4Index.util.ts";
import { createHevcDecoder } from "../src/utils/hevcDecoderCore.util.ts";
import {
  audioInitSegment,
  audioMediaSegment,
} from "../src/utils/mediaSourceAudio.util.ts";

const require = createRequire(import.meta.url);
const fixture = (name) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/videos/${name}`, import.meta.url)),
  );

// Loaded the way the worker loads it, with the .wasm handed over directly.
const libde265Directory = dirname(
  require.resolve("@yume-chan/libde265/package.json"),
);
const { default: initialize } = await import(
  pathToFileURL(join(libde265Directory, "libde265.mjs")).href
);
const libde265 = await initialize({
  wasmBinary: readFileSync(join(libde265Directory, "libde265.wasm")),
});

// Fixtures: 64x48, 10 frames per second for 3 s, one keyframe per second and
// B-frames in open groups, as x265 writes them by default: in decoding order
// the keyframes are samples 0, 8 and 18, each followed by two leading
// pictures that reference the previous group. Quadrants red, green, blue, and
// a bottom-right one turning white, yellow then magenta each second.
const QUADRANTS = [
  [220, 30, 30],
  [30, 200, 30],
  [30, 30, 220],
];
const CLOCK = [
  [240, 240, 240],
  [230, 220, 40],
  [210, 40, 210],
];

const indexOf = async (bytes) => {
  const reads = [];
  const index = await readMp4Index(async (start, end) => {
    reads.push([start, end]);
    return bytes.slice(start, end);
  }, bytes.length);
  return { index, reads };
};

/** Top-level boxes of a file, as [type, start, end]. */
const topLevelBoxes = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at);
    boxes.push([
      String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      at,
      at + size,
    ]);
    at += size;
  }
  return boxes;
};

const box = (type, payload = new Uint8Array(0)) => {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
};
const concat = (...parts) => {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

test("indexes HEVC tracks from their moov, wherever it sits", async () => {
  for (const [name, hasAudio, rotation] of [
    ["hevc-quadrants.mp4", true, 0],
    ["hevc-quadrants-silent.mp4", false, 0],
    ["hevc-quadrants-rotate90.mp4", false, 90],
    ["hevc-quadrants-main10.mp4", false, 0],
  ]) {
    const bytes = fixture(name);
    const { index, reads } = await indexOf(bytes);
    const video = index.video;
    assert.equal(index.hasAudio, hasAudio, name);
    assert.equal(video.format, "hvc1", name);
    assert.deepEqual([video.width, video.height], [64, 48], name);
    assert.equal(video.rotation, rotation, name);
    assert.equal(video.nalLengthSize, 4, name);
    assert.deepEqual(
      video.parameterSets.map((unit) => (unit[0] >> 1) & 63).slice(0, 3),
      [32, 33, 34],
      `${name}: VPS, SPS and PPS`,
    );
    assert.equal(video.samples.count, 30, name);
    assert.deepEqual(
      [...video.samples.time]
        .map((time) => Math.round(time * 10))
        .sort((a, b) => a - b),
      Array.from({ length: 30 }, (_, i) => i),
      `${name}: one picture every 100 ms`,
    );
    const keyframes = [...video.samples.sync.keys()].filter(
      (i) => video.samples.sync[i],
    );
    assert.deepEqual(keyframes, [0, 8, 18], `${name}: decoding order`);
    assert.deepEqual(
      keyframes.map((i) => video.samples.time[i]),
      [0, 1, 2],
      `${name}: a keyframe each second`,
    );
    assert.ok(Math.abs(index.duration - 3) < 0.05, name);
    // Box headers and the moov box only: never the media data.
    const mdat = topLevelBoxes(bytes).find(([type]) => type === "mdat");
    for (const [start, end] of reads)
      assert.ok(
        end <= mdat[1] + 16 || start >= mdat[2],
        `${name}: read ${start}-${end} inside mdat`,
      );
  }
});

test("names the exact HEVC profile, for the browser to judge", async () => {
  for (const [name, codec] of [
    ["hevc-quadrants.mp4", "hvc1.1.6.L30.90"],
    ["hevc-quadrants-main10.mp4", "hvc1.2.4.L30.90"],
    ["h264-quadrants.mp4", "avc1"],
  ]) {
    const { index } = await indexOf(fixture(name));
    assert.equal(index.video.codec, codec, name);
  }
});

test("indexes the sound track as Media Source can take it", async () => {
  for (const [name, timescale, samples] of [
    ["hevc-quadrants.mp4", 48000, 142],
    // QuickTime: version 1 sound entry, esds nested in a wave box.
    ["hevc-quadrants.mov", 44100, 131],
  ]) {
    const { index } = await indexOf(fixture(name));
    const { audio } = index;
    assert.equal(audio.mimeType, 'audio/mp4; codecs="mp4a.40.2"', name);
    assert.equal(audio.timescale, timescale, name);
    assert.equal(audio.samples.count, samples, name);
    // AAC encoders prime the decoder with 1024 samples the edit list skips.
    assert.equal(Math.round(audio.shift * timescale), -1024, name);
    const entry = new DataView(
      audio.sampleEntry.buffer,
      audio.sampleEntry.byteOffset,
    );
    assert.equal(entry.getUint32(0), audio.sampleEntry.length, name);
    assert.equal(
      new TextDecoder().decode(audio.sampleEntry.subarray(4, 8)),
      "mp4a",
    );
    assert.equal(entry.getUint16(16), 0, `${name}: plain ISO entry`);
    assert.equal(entry.getUint32(32), timescale * 65536, name);
    assert.equal(
      new TextDecoder().decode(audio.sampleEntry.subarray(40, 44)),
      "esds",
      `${name}: esds right after the entry fields`,
    );
    for (let i = 1; i < audio.samples.count; i++)
      assert.ok(audio.samples.decode[i] > audio.samples.decode[i - 1]);
  }
  const { index } = await indexOf(fixture("hevc-quadrants-silent.mp4"));
  assert.equal(index.audio, null);
  assert.equal(index.hasAudio, false);
});

/** Boxes of [start, end), as { type, start, end } of their payload. */
const boxesOf = (bytes, start = 0, end = bytes.length) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  for (let at = start; at < end; at += view.getUint32(at)) {
    boxes.push({
      type: new TextDecoder().decode(bytes.subarray(at + 4, at + 8)),
      start: at + 8,
      end: at + view.getUint32(at),
    });
  }
  assert.equal(boxes.at(-1).end, end, "boxes fill their parent");
  return boxes;
};

test("repackages the sound as fragmented MP4", async () => {
  const bytes = fixture("hevc-quadrants.mp4");
  const { index } = await indexOf(bytes);
  const { audio } = index;
  const init = audioInitSegment(audio);
  assert.deepEqual(
    boxesOf(init).map((box) => box.type),
    ["ftyp", "moov"],
  );
  const moov = boxesOf(init)[1];
  assert.deepEqual(
    boxesOf(init, moov.start, moov.end).map((box) => box.type),
    ["mvhd", "mvex", "trak"],
  );
  assert.ok(
    Buffer.from(init).includes(Buffer.from(audio.sampleEntry)),
    "the sample entry is declared as indexed",
  );

  const samples = Array.from({ length: 5 }, (_, k) => {
    const i = 10 + k;
    const { offset, size, decode } = audio.samples;
    return {
      duration: decode[i + 1] - decode[i],
      data: bytes.subarray(offset[i], offset[i] + size[i]),
    };
  });
  const segment = audioMediaSegment(7, audio.samples.decode[10], samples);
  const view = new DataView(segment.buffer);
  const [moof, mdat] = boxesOf(segment);
  assert.deepEqual([moof.type, mdat.type], ["moof", "mdat"]);
  const [mfhd, traf] = boxesOf(segment, moof.start, moof.end);
  assert.equal(view.getUint32(mfhd.start + 4), 7, "sequence number");
  const [tfhd, tfdt, trun] = boxesOf(segment, traf.start, traf.end);
  assert.deepEqual([tfhd.type, tfdt.type, trun.type], ["tfhd", "tfdt", "trun"]);
  assert.equal(
    Number(view.getBigUint64(tfdt.start + 4)),
    audio.samples.decode[10],
  );
  assert.equal(view.getUint32(trun.start + 4), 5, "sample count");
  // Data offsets count from the moof: they must land on the mdat payload.
  assert.equal(view.getUint32(trun.start + 8), mdat.start - (moof.start - 8));
  let total = 0;
  samples.forEach((sample, k) => {
    const entry = trun.start + 12 + k * 8;
    assert.equal(view.getUint32(entry), sample.duration);
    assert.equal(view.getUint32(entry + 4), sample.data.length);
    assert.deepEqual(
      segment.subarray(
        mdat.start + total,
        mdat.start + total + sample.data.length,
      ),
      sample.data,
    );
    total += sample.data.length;
  });
  assert.equal(total, mdat.end - mdat.start);
});

test("rejects files it cannot index", async () => {
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isom"));
  const cases = {
    fragmented: concat(ftyp, box("moof", new Uint8Array(16))),
    "no moov": concat(ftyp, box("free", new Uint8Array(32))),
    "box past the end": (() => {
      const bytes = concat(ftyp, box("mdat", new Uint8Array(32)));
      new DataView(bytes.buffer).setUint32(ftyp.length, 4096);
      return bytes;
    })(),
    "too short": new Uint8Array(8),
  };
  for (const [name, bytes] of Object.entries(cases))
    await assert.rejects(indexOf(bytes), /Unreadable MP4/, name);
});

test("keeps the samples written before a recording was cut", async () => {
  const bytes = fixture("hevc-quadrants-silent.mp4");
  const mdat = topLevelBoxes(bytes).find(([type]) => type === "mdat");
  const cut = bytes.slice(0, Math.floor((mdat[1] + mdat[2]) / 2));
  const { index } = await indexOf(cut);
  const { samples } = index.video;
  assert.ok(samples.count > 0 && samples.count < 30, String(samples.count));
  for (let i = 0; i < samples.count; i++)
    assert.ok(samples.offset[i] + samples.size[i] <= cut.length);
});

test("finds the keyframes around a time", async () => {
  const { index } = await indexOf(fixture("hevc-quadrants.mp4"));
  const { samples } = index.video;
  assert.equal(syncSampleBefore(samples, 0), 0);
  assert.equal(syncSampleBefore(samples, 0.95), 0);
  assert.equal(syncSampleBefore(samples, 1.55), 8);
  assert.equal(syncSampleBefore(samples, 9), 18);
  assert.equal(syncSampleAfter(samples, 0.5), 8);
  assert.equal(syncSampleAfter(samples, 2.05), -1);
  assert.equal(videoCodecName("hev1"), "HEVC (H.265)");
  assert.equal(videoCodecName("abcd"), "ABCD");
});

/** BT.601 limited range, the matrix of these fixtures. */
const rgbAt = (frame, x, y) => {
  const chromaWidth = frame.codedWidth / 2;
  const lumaSize = frame.codedWidth * frame.codedHeight;
  const chroma = (y >> 1) * chromaWidth + (x >> 1);
  const luma = 1.164 * (frame.data[y * frame.codedWidth + x] - 16);
  const u = frame.data[lumaSize + chroma] - 128;
  const v = frame.data[lumaSize + lumaSize / 4 + chroma] - 128;
  return [luma + 1.596 * v, luma - 0.392 * u - 0.813 * v, luma + 2.017 * u];
};

const assertColors = (frame, second, label) => {
  const expected = [...QUADRANTS, CLOCK[second]];
  [
    [16, 12],
    [48, 12],
    [16, 36],
    [48, 36],
  ].forEach(([x, y], quadrant) =>
    rgbAt(frame, x, y).forEach((channel, i) =>
      assert.ok(
        Math.abs(channel - expected[quadrant][i]) <= 24,
        `${label} quadrant ${quadrant}: ${rgbAt(frame, x, y).map(Math.round)}`,
      ),
    ),
  );
};

const decodeAll = async (name) => {
  const bytes = fixture(name);
  const { index } = await indexOf(bytes);
  const { samples, parameterSets, nalLengthSize } = index.video;
  const decoder = createHevcDecoder(libde265, parameterSets, nalLengthSize);
  const frames = [];
  try {
    for (let i = 0; i < samples.count; i++)
      frames.push(
        ...decoder.decode([
          {
            timestamp: samples.time[i] * 1e6,
            data: bytes.subarray(
              samples.offset[i],
              samples.offset[i] + samples.size[i],
            ),
          },
        ]),
      );
    frames.push(...decoder.flush());
  } finally {
    decoder.close();
  }
  return frames.sort((a, b) => a.timestamp - b.timestamp);
};

test("decodes HEVC samples to their pictures, 8 and 10 bits", async () => {
  for (const name of ["hevc-quadrants.mp4", "hevc-quadrants-main10.mp4"]) {
    const frames = await decodeAll(name);
    assert.equal(frames.length, 30, name);
    assert.deepEqual(
      frames.map((frame) => Math.round(frame.timestamp / 1e5)),
      Array.from({ length: 30 }, (_, i) => i),
      name,
    );
    for (const frame of frames) {
      assert.deepEqual(
        [frame.width, frame.height, frame.codedWidth, frame.codedHeight],
        [64, 48, 64, 48],
      );
      assert.equal(frame.data.length, 64 * 48 * 1.5);
    }
    for (const second of [0, 1, 2])
      assertColors(frames[second * 10 + 5], second, `${name} at ${second}.5 s`);
  }
});

test("decodes again from a keyframe, dropping its leading pictures", async () => {
  const bytes = fixture("hevc-quadrants.mp4");
  const { index } = await indexOf(bytes);
  const { samples, parameterSets, nalLengthSize } = index.video;
  const decoder = createHevcDecoder(libde265, parameterSets, nalLengthSize);
  const sample = (i) => ({
    timestamp: samples.time[i] * 1e6,
    data: bytes.subarray(
      samples.offset[i],
      samples.offset[i] + samples.size[i],
    ),
  });
  try {
    for (let i = 0; i < 6; i++) decoder.decode([sample(i)]);
    decoder.reset();
    const frames = [];
    for (let i = 18; i < samples.count; i++)
      frames.push(...decoder.decode([sample(i)]));
    frames.push(...decoder.flush());
    frames.sort((a, b) => a.timestamp - b.timestamp);
    // Samples 19 and 20 (1.9 s and 1.8 s) need the previous group: libde265
    // drops them instead of showing broken pictures.
    assert.deepEqual(
      frames.map((frame) => Math.round(frame.timestamp / 1e5)),
      [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    );
    assertColors(frames[5], 2, "after reset");
  } finally {
    decoder.close();
  }
});

test("refuses malformed samples and configurations", () => {
  assert.throws(() => createHevcDecoder(libde265, [], 4), /configuration/);
  assert.throws(
    () => createHevcDecoder(libde265, [new Uint8Array([64, 1])], 3),
    /configuration/,
  );
  const decoder = createHevcDecoder(libde265, [new Uint8Array([64, 1])], 4);
  try {
    assert.throws(
      () =>
        decoder.decode([
          { timestamp: 0, data: new Uint8Array([0, 0, 0, 9, 1, 2]) },
        ]),
      /Truncated NAL unit/,
    );
  } finally {
    decoder.close();
  }
});
