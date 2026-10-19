import type { Mp4AudioTrack, ReadBytes } from "./mp4Index.util";

/**
 * Gives a media element the sound of a file, alone: the samples of its sound
 * track are repackaged as fragmented MP4 and appended to a MediaSource a few
 * seconds ahead of the playback position. Pointed at the whole file, the
 * element would read its video data as well, far ahead and more than once.
 */

const AHEAD_SECONDS = 6;
const BEHIND_SECONDS = 20;
const SEGMENT_SECONDS = 2;

const concat = (parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

const u16 = (value: number) => Uint8Array.of(value >>> 8, value & 255);
const u32 = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0));
  return bytes;
};
const u64 = (value: number) =>
  u32(Math.floor(value / 2 ** 32), value % 2 ** 32);
const zeros = (length: number) => new Uint8Array(length);

const box = (type: string, ...parts: Uint8Array[]) => {
  const body = concat(parts);
  const bytes = new Uint8Array(8 + body.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(body, 8);
  return bytes;
};
const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
) =>
  box(
    type,
    Uint8Array.of(
      version,
      (flags >> 16) & 255,
      (flags >> 8) & 255,
      flags & 255,
    ),
    ...parts,
  );

const IDENTITY = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
const ascii = (text: string) =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

/** ftyp and moov declaring one fragmented sound track. */
export function audioInitSegment(track: Mp4AudioTrack) {
  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso6mp41"));
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0, 0, track.timescale, 0, 0x10000),
    u16(0x100),
    zeros(10),
    IDENTITY,
    zeros(24),
    u32(2),
  );
  const tkhd = fullBox(
    "tkhd",
    0,
    3,
    u32(0, 0, 1, 0, 0),
    zeros(8),
    u16(0),
    u16(0),
    u16(0x100),
    u16(0),
    IDENTITY,
    u32(0, 0),
  );
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0, 0, track.timescale, 0),
    u16(0x55c4), // "und"
    u16(0),
  );
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii("soun"),
    zeros(12),
    ascii("SoundHandler\0"),
  );
  const dinf = box(
    "dinf",
    fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)),
  );
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), track.sampleEntry),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0, 0)),
    fullBox("stco", 0, 0, u32(0)),
  );
  const minf = box("minf", fullBox("smhd", 0, 0, u32(0)), dinf, stbl);
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  const mvex = box("mvex", fullBox("trex", 0, 0, u32(1, 1, 0, 0, 0)));
  return concat([ftyp, box("moov", mvhd, mvex, trak)]);
}

/** One moof and mdat pair; durations are in the track timescale. */
export function audioMediaSegment(
  sequence: number,
  baseDecodeTime: number,
  samples: { duration: number; data: Uint8Array }[],
) {
  const moof = (dataOffset: number) =>
    box(
      "moof",
      fullBox("mfhd", 0, 0, u32(sequence)),
      box(
        "traf",
        // Sample data offsets are counted from this moof.
        fullBox("tfhd", 0, 0x020000, u32(1)),
        fullBox("tfdt", 1, 0, u64(baseDecodeTime)),
        fullBox(
          "trun",
          0,
          0x000301, // data offset, sample durations and sizes
          u32(samples.length, dataOffset),
          ...samples.map((sample) => u32(sample.duration, sample.data.length)),
        ),
      ),
    );
  const header = moof(0);
  return concat([
    moof(header.length + 8),
    box("mdat", ...samples.map((sample) => sample.data)),
  ]);
}

export const canPlayAudioFragments = (track: Mp4AudioTrack) =>
  typeof MediaSource === "function" &&
  MediaSource.isTypeSupported(track.mimeType);

export class MediaSourceAudio {
  private readonly element: HTMLMediaElement;
  private readonly track: Mp4AudioTrack;
  private readonly read: ReadBytes;
  private readonly signal: AbortSignal;
  private readonly onError: () => void;
  private readonly source = new MediaSource();
  private readonly url: string;
  private buffer: SourceBuffer | null = null;
  /** Next sample to append. A seek bumps the generation of pending reads. */
  private next = 0;
  private generation = 0;
  private sequence = 1;
  private loading = false;
  private closed = false;
  private readAbort = new AbortController();

  constructor(
    element: HTMLMediaElement,
    track: Mp4AudioTrack,
    read: ReadBytes,
    signal: AbortSignal,
    onError: () => void,
  ) {
    this.element = element;
    this.track = track;
    this.read = read;
    this.signal = signal;
    this.onError = onError;
    this.source.addEventListener("sourceopen", this.open, { once: true });
    element.addEventListener("timeupdate", this.fill);
    element.addEventListener("seeking", this.seeking);
    this.url = URL.createObjectURL(this.source);
    element.src = this.url;
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.readAbort.abort();
    this.element.removeEventListener("timeupdate", this.fill);
    this.element.removeEventListener("seeking", this.seeking);
    this.buffer?.removeEventListener("updateend", this.fill);
    URL.revokeObjectURL(this.url);
    this.element.removeAttribute("src");
    this.element.load();
  }

  private fail = () => {
    if (this.closed) return;
    this.destroy();
    this.onError();
  };

  private open = () => {
    // Attached: the element no longer needs the URL.
    URL.revokeObjectURL(this.url);
    try {
      const { samples } = this.track;
      const last = samples.count - 1;
      this.source.duration =
        last < 0
          ? this.track.duration
          : Math.max(this.track.duration, samples.time[last]);
      const buffer = this.source.addSourceBuffer(this.track.mimeType);
      buffer.mode = "segments";
      buffer.timestampOffset = this.track.shift;
      buffer.addEventListener("updateend", this.fill);
      buffer.addEventListener("error", this.fail);
      this.buffer = buffer;
      buffer.appendBuffer(audioInitSegment(this.track));
    } catch {
      this.fail();
    }
  };

  /** Seeking outside the buffered sound restarts the appends there. */
  private seeking = () => {
    const time = this.element.currentTime;
    const buffered = this.buffer?.buffered;
    let from = time;
    if (buffered)
      for (let i = 0; i < buffered.length; i++)
        if (buffered.start(i) <= time && time < buffered.end(i))
          from = buffered.end(i);
    const { samples } = this.track;
    let sample = 0;
    while (sample < samples.count && samples.time[sample] < from - 0.05)
      sample++;
    this.next = sample;
    this.generation++;
    this.readAbort.abort();
    this.readAbort = new AbortController();
    this.loading = false;
    this.fill();
  };

  private fill = () => {
    const buffer = this.buffer;
    if (
      this.closed ||
      !buffer ||
      buffer.updating ||
      this.loading ||
      this.source.readyState === "closed"
    )
      return;
    const time = this.element.currentTime;
    const { samples } = this.track;
    try {
      if (
        buffer.buffered.length &&
        buffer.buffered.start(0) < time - BEHIND_SECONDS
      ) {
        buffer.remove(0, time - BEHIND_SECONDS);
        return;
      }
      if (this.next >= samples.count) {
        if (this.source.readyState === "open") this.source.endOfStream();
        return;
      }
    } catch {
      return this.fail();
    }
    if (samples.time[this.next] > time + AHEAD_SECONDS) return;
    const first = this.next;
    let last = first + 1;
    while (
      last < samples.count &&
      samples.time[last] < samples.time[first] + SEGMENT_SECONDS
    )
      last++;
    const generation = this.generation;
    this.loading = true;
    this.segment(first, last, this.readAbort.signal)
      .then((segment) => {
        if (this.closed || generation !== this.generation) return;
        this.loading = false;
        this.next = last;
        buffer.appendBuffer(segment);
      })
      .catch(() => {
        if (!this.signal.aborted && generation === this.generation) this.fail();
      });
  };

  /** Reads samples [first, last), one read per run contiguous in the file. */
  private async segment(first: number, last: number, signal: AbortSignal) {
    const { samples } = this.track;
    const data: Uint8Array[] = [];
    for (let run = first; run < last; ) {
      let end = run + 1;
      while (
        end < last &&
        samples.offset[end] === samples.offset[end - 1] + samples.size[end - 1]
      )
        end++;
      const start = samples.offset[run];
      const bytes = await this.read(
        start,
        samples.offset[end - 1] + samples.size[end - 1],
        signal,
      );
      for (let i = run; i < end; i++) {
        const at = samples.offset[i] - start;
        data.push(bytes.subarray(at, at + samples.size[i]));
      }
      run = end;
    }
    const durationOf = (i: number) =>
      i + 1 < samples.count
        ? samples.decode[i + 1] - samples.decode[i]
        : i > 0
          ? samples.decode[i] - samples.decode[i - 1]
          : 1024;
    return audioMediaSegment(
      this.sequence++,
      samples.decode[first],
      data.map((bytes, i) => ({
        duration: durationOf(first + i),
        data: bytes,
      })),
    );
  }
}
