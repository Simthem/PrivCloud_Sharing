import { type PreviewByteSource, readPreviewBytes } from "./previewRange.util";

const WORKER_URL = "/video-decoders/media.worker.js";
/** Seconds prepared ahead of the position while the video plays or waits. */
const AHEAD_SECONDS = 60;
const MIN_AHEAD_SECONDS = 10;
/** Kept behind the position, so a short step back needs nothing new. */
const BEHIND_SECONDS = 20;
const BUFFER_BYTES = 120 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const PREFETCH_BYTES = 8 * 1024 * 1024;
const MAX_INIT_BYTES = 4 * 1024 * 1024;

type SourceConstructor = typeof MediaSource;

const mediaSourceClass = (): SourceConstructor | null => {
  if (typeof window === "undefined") return null;
  const managed = (window as { ManagedMediaSource?: SourceConstructor })
    .ManagedMediaSource;
  return window.MediaSource ?? managed ?? null;
};

export const canUseMediaEngine = () =>
  typeof Worker === "function" &&
  typeof WebAssembly === "object" &&
  mediaSourceClass() !== null;

const mp4Supported = (codec: string) =>
  mediaSourceClass()?.isTypeSupported(`video/mp4; codecs="${codec}"`) === true;

/** Pictures the engine may hand over to the browser without re-encoding. */
const supportedCodecs = () => ({
  h264: mp4Supported("avc1.640028"),
  hevc: mp4Supported("hvc1.1.6.L123.B0"),
  vp9: mp4Supported("vp09.00.40.08"),
  av1: mp4Supported("av01.0.08M.08"),
});

const hex = (value: number) => value.toString(16).padStart(2, "0");
const decimal = (value: number) => String(value).padStart(2, "0");

type Box = { type: string; start: number; end: number };

function* boxes(bytes: Uint8Array, start: number, end: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    yield { type, start: at + header, end: at + size } satisfies Box;
    at += size;
  }
}

const child = (bytes: Uint8Array, parent: Box, type: string, skip = 0) => {
  for (const box of boxes(bytes, parent.start + skip, parent.end))
    if (box.type === type) return box;
  return null;
};

const reverseBits32 = (value: number) => {
  let out = 0;
  for (let i = 0; i < 32; i++) out = (out << 1) | ((value >>> i) & 1);
  return out >>> 0;
};

/** RFC 6381 name of one MP4 sample entry, from its configuration box. */
function sampleEntryCodec(bytes: Uint8Array, entry: Box): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Visual sample entries have 78 bytes before their boxes, audio ones 28.
  if (entry.type === "avc1" || entry.type === "avc3") {
    const config = child(bytes, entry, "avcC", 78);
    if (!config || config.end - config.start < 4) return null;
    const at = config.start;
    return `avc1.${hex(bytes[at + 1])}${hex(bytes[at + 2])}${hex(bytes[at + 3])}`;
  }
  if (entry.type === "hvc1" || entry.type === "hev1") {
    const config = child(bytes, entry, "hvcC", 78);
    if (!config || config.end - config.start < 13) return null;
    const at = config.start;
    const space = ["", "A", "B", "C"][bytes[at + 1] >> 6];
    const tier = bytes[at + 1] & 0x20 ? "H" : "L";
    const profile = bytes[at + 1] & 0x1f;
    const compatibility = reverseBits32(view.getUint32(at + 2)).toString(16);
    const constraints = Array.from(bytes.subarray(at + 6, at + 12));
    while (constraints.length && constraints[constraints.length - 1] === 0)
      constraints.pop();
    return [
      entry.type,
      `${space}${profile}`,
      compatibility,
      `${tier}${bytes[at + 12]}`,
      ...constraints.map((value) => value.toString(16).toUpperCase()),
    ].join(".");
  }
  if (entry.type === "vp09") {
    const config = child(bytes, entry, "vpcC", 78);
    if (!config || config.end - config.start < 7) return null;
    const at = config.start + 4;
    return `vp09.${decimal(bytes[at])}.${decimal(bytes[at + 1])}.${decimal(bytes[at + 2] >> 4)}`;
  }
  if (entry.type === "av01") {
    const config = child(bytes, entry, "av1C", 78);
    if (!config || config.end - config.start < 4) return null;
    const at = config.start;
    const profile = bytes[at + 1] >> 5;
    const level = bytes[at + 1] & 0x1f;
    const tier = bytes[at + 2] & 0x80 ? "H" : "M";
    const depth =
      bytes[at + 2] & 0x40
        ? profile === 2 && bytes[at + 2] & 0x20
          ? 12
          : 10
        : 8;
    return `av01.${profile}.${decimal(level)}${tier}.${decimal(depth)}`;
  }
  if (entry.type === "mp4a") {
    const config = child(bytes, entry, "esds", 28);
    if (!config) return null;
    // Descriptors: ES (3), then decoder configuration (4), then the
    // decoder specific information (5) whose first five bits name the object.
    let at = config.start + 4;
    const end = config.end;
    const descriptor = () => {
      const tag = bytes[at++];
      let length = 0;
      for (let i = 0; i < 4 && at < end; i++) {
        const byte = bytes[at++];
        length = (length << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) break;
      }
      return { tag, length };
    };
    if (descriptor().tag !== 3) return null;
    at += 3;
    if (descriptor().tag !== 4) return null;
    const object = bytes[at];
    at += 13;
    if (descriptor().tag !== 5 || at >= end) return `mp4a.${hex(object)}`;
    return `mp4a.${hex(object)}.${bytes[at] >> 3}`;
  }
  return null;
}

/** The codecs parameter of a fragmented MP4 initialization segment. */
export function codecsOfInitSegment(bytes: Uint8Array): string | null {
  const codecs: string[] = [];
  for (const top of boxes(bytes, 0, bytes.length)) {
    if (top.type !== "moov") continue;
    for (const trak of boxes(bytes, top.start, top.end)) {
      if (trak.type !== "trak") continue;
      const mdia = child(bytes, trak, "mdia");
      const minf = mdia && child(bytes, mdia, "minf");
      const stbl = minf && child(bytes, minf, "stbl");
      const stsd = stbl && child(bytes, stbl, "stsd");
      if (!stsd) return null;
      const entry = boxes(bytes, stsd.start + 8, stsd.end).next().value;
      const codec = entry && sampleEntryCodec(bytes, entry);
      if (!codec) return null;
      codecs.push(codec);
    }
  }
  return codecs.length ? codecs.join(",") : null;
}

type Chunk = { epoch: number; base: number; data: ArrayBuffer };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Plays a file the browser cannot open itself in a browser media element:
 * the media worker turns it into fragmented MP4, appended to MediaSource well
 * ahead of the position like a streaming player. Bytes come from `source`,
 * so encrypted files are decrypted in this page only.
 */
export class MediaEnginePlayback {
  private readonly video: HTMLMediaElement;
  private readonly source: PreviewByteSource;
  private readonly onError: (_unsupported: boolean) => void;
  private readonly worker: Worker;
  private readonly abort = new AbortController();
  private mediaSource: MediaSource | null = null;
  private url: string | null = null;
  private buffer: SourceBuffer | null = null;
  private queue: Chunk[] = [];
  private epoch = 0;
  private base: number | null = null;
  private clearing = false;
  private ended = new Set<number>();
  private duration = 0;
  private ahead = AHEAD_SECONDS;
  private requested = -1;
  private appendedBytes = 0;
  private appendedSeconds = 0;
  private epochStart = 0;
  private destroyed = false;

  constructor(
    video: HTMLMediaElement,
    source: PreviewByteSource,
    mimeType: string,
    onError: (_unsupported: boolean) => void,
  ) {
    this.video = video;
    this.source = source;
    this.onError = onError;
    this.worker = new Worker(WORKER_URL, { type: "module" });
    this.worker.onmessage = this.receive;
    this.worker.onerror = () => this.fail(false);
    this.worker.postMessage({
      type: "open",
      size: source.size,
      mimeType,
      supported: supportedCodecs(),
    });
    video.addEventListener("seeking", this.seeking);
    video.addEventListener("timeupdate", this.request);
    video.addEventListener("waiting", this.request);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.worker.terminate();
    this.video.removeEventListener("seeking", this.seeking);
    this.video.removeEventListener("timeupdate", this.request);
    this.video.removeEventListener("waiting", this.request);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.queue = [];
  }

  private fail(unsupported: boolean) {
    if (this.destroyed) return;
    this.destroy();
    this.onError(unsupported);
  }

  private receive = (event: MessageEvent<unknown>) => {
    if (this.destroyed || !isRecord(event.data)) return;
    const message = event.data;
    switch (message.type) {
      case "read":
        return this.read(message.id, message.start, message.end);
      case "ready":
        if (typeof message.duration === "number")
          return this.attach(message.duration);
        return;
      case "data":
        if (
          typeof message.epoch === "number" &&
          typeof message.base === "number" &&
          Number.isFinite(message.base) &&
          message.data instanceof ArrayBuffer
        ) {
          if (message.epoch !== this.epoch) return;
          this.queue.push({
            epoch: message.epoch,
            base: message.base,
            data: message.data,
          });
          if (typeof message.until === "number")
            this.appendedSeconds = Math.max(
              this.appendedSeconds,
              message.until - this.epochStart,
            );
          this.pump();
        }
        return;
      case "end":
        if (typeof message.epoch === "number") {
          this.ended.add(message.epoch);
          this.pump();
        }
        return;
      case "error":
        return this.fail(message.reason === "unsupported");
    }
  };

  private read(id: unknown, start: unknown, end: unknown) {
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number) ||
      (end as number) > this.source.size ||
      (end as number) - (start as number) > MAX_READ_BYTES
    )
      return this.fail(false);
    // The demuxer reads on from here: the next MiB are prepared meanwhile.
    this.source.prefetch?.(
      end as number,
      (end as number) + PREFETCH_BYTES,
      this.abort.signal,
    );
    readPreviewBytes(
      this.source,
      start as number,
      end as number,
      this.abort.signal,
    ).then(
      (bytes) => {
        if (this.destroyed) return;
        this.worker.postMessage({ type: "bytes", id, data: bytes.buffer }, [
          bytes.buffer,
        ]);
      },
      () => {
        if (!this.destroyed)
          this.worker.postMessage({ type: "bytes", id, error: true });
      },
    );
  }

  private attach(duration: number) {
    const Source = mediaSourceClass();
    if (!Source || this.mediaSource) return this.fail(true);
    this.duration = duration;
    const mediaSource = new Source();
    this.mediaSource = mediaSource;
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (this.destroyed) return;
        if (duration > 0) mediaSource.duration = duration;
        this.request();
      },
      { once: true },
    );
    if (Source !== window.MediaSource) {
      // A managed source plays only without remote playback (AirPlay).
      this.video.disableRemotePlayback = true;
    }
    this.url = URL.createObjectURL(mediaSource);
    this.video.src = this.url;
  }

  /** Asks the worker for what keeps the buffer ahead of the position. */
  private request = () => {
    if (this.destroyed || this.mediaSource?.readyState === "closed") return;
    if (!this.mediaSource) return;
    // Also retries an append refused while the buffer was full.
    this.pump();
    const until = this.video.currentTime + this.ahead;
    if (until <= this.requested + 1) return;
    this.requested = until;
    this.worker.postMessage({ type: "want", epoch: this.epoch, until });
  };

  private seeking = () => {
    const time = this.video.currentTime;
    const { buffered } = this.video;
    for (let i = 0; i < buffered.length; i++)
      if (buffered.start(i) <= time + 0.1 && buffered.end(i) > time + 0.5)
        return this.request();
    this.epoch++;
    this.queue = [];
    this.base = null;
    this.requested = -1;
    this.epochStart = time;
    this.appendedSeconds = 0;
    this.appendedBytes = 0;
    this.clearing = true;
    this.worker.postMessage({ type: "seek", epoch: this.epoch, time });
    this.pump();
  };

  private evict(): boolean {
    const buffer = this.buffer;
    if (!buffer || buffer.updating || !buffer.buffered.length) return false;
    const keepFrom = this.video.currentTime - BEHIND_SECONDS;
    if (buffer.buffered.start(0) < keepFrom - 5) {
      buffer.remove(0, keepFrom);
      return true;
    }
    return false;
  }

  private pump = (): void => {
    const mediaSource = this.mediaSource;
    if (this.destroyed || !mediaSource || mediaSource.readyState === "closed")
      return;
    if (this.buffer?.updating) return;
    if (this.clearing) {
      this.clearing = false;
      if (this.buffer?.buffered.length) {
        if (mediaSource.readyState === "open") this.buffer.abort();
        this.buffer.remove(0, Infinity);
        return;
      }
    }
    const chunk = this.queue[0];
    if (!chunk) {
      if (
        this.ended.has(this.epoch) &&
        mediaSource.readyState === "open" &&
        this.buffer
      )
        mediaSource.endOfStream();
      return;
    }
    if (chunk.epoch !== this.epoch) {
      this.queue.shift();
      return this.pump();
    }
    if (!this.buffer) {
      if (mediaSource.readyState !== "open") return;
      // The initialization segment may span several messages.
      const init = new Uint8Array(
        this.queue.reduce((total, item) => total + item.data.byteLength, 0),
      );
      let at = 0;
      for (const item of this.queue) {
        init.set(new Uint8Array(item.data), at);
        at += item.data.byteLength;
      }
      const codecs = codecsOfInitSegment(init);
      if (
        !codecs &&
        !this.ended.has(this.epoch) &&
        init.length < MAX_INIT_BYTES
      )
        return;
      const kind = codecs?.split(",").every((codec) => codec.startsWith("mp4a"))
        ? "audio"
        : "video";
      const type = `${kind}/mp4; codecs="${codecs}"`;
      if (!codecs || !mediaSourceClass()?.isTypeSupported(type))
        return this.fail(true);
      try {
        this.buffer = mediaSource.addSourceBuffer(type);
      } catch {
        return this.fail(true);
      }
      this.buffer.addEventListener("updateend", this.updated);
      this.buffer.addEventListener("error", () => this.fail(false));
    }
    if (this.evict()) return;
    if (this.base !== chunk.base) {
      // Each pipeline starts at 0 from a keyframe: its place in the video.
      this.buffer.timestampOffset = chunk.base;
      this.base = chunk.base;
    }
    try {
      this.buffer.appendBuffer(chunk.data);
      this.queue.shift();
      this.appendedBytes += chunk.data.byteLength;
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "QuotaExceededError"
      ) {
        // Less ahead, and the next try once playback moved on.
        this.ahead = Math.max(MIN_AHEAD_SECONDS, this.ahead / 2);
        this.evict();
        return;
      }
      this.fail(false);
    }
  };

  /** A first keyframe after 0 leaves a gap the position would wait in. */
  private skipLeadingGap() {
    const { buffered, currentTime } = this.video;
    if (this.video.seeking || !buffered.length) return;
    const start = buffered.start(0);
    if (currentTime < start && start - currentTime < 30)
      this.video.currentTime = start;
  }

  private updated = () => {
    this.skipLeadingGap();
    // A high bitrate keeps fewer seconds, a bounded number of bytes.
    if (this.appendedSeconds > 0 && this.appendedBytes > 0) {
      const perSecond = this.appendedBytes / Math.max(1, this.appendedSeconds);
      this.ahead = Math.max(
        MIN_AHEAD_SECONDS,
        Math.min(AHEAD_SECONDS, BUFFER_BYTES / perSecond),
      );
    }
    this.pump();
    this.request();
  };
}
