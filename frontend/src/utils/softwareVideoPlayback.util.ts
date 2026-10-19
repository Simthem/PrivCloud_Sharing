import { createPreviewReadCache } from "./previewReadCache.util";
import type { DecodedVideoFrame } from "./hevcDecoderCore.util";
import {
  canPlayAudioFragments,
  MediaSourceAudio,
} from "./mediaSourceAudio.util";
import {
  type Mp4AudioTrack,
  type Mp4VideoTrack,
  type ReadBytes,
  syncSampleAfter,
  syncSampleBefore,
} from "./mp4Index.util";

/**
 * Plays an HEVC track the browser cannot decode: libde265 decodes it in
 * public/video-decoders/hevc.worker.js, pictures are drawn on a canvas, and
 * the browser still plays the sound, which keeps the time when there is any.
 */

export type SoftwarePlaybackState = {
  /** A first picture is on the canvas. */
  ready: boolean;
  playing: boolean;
  /** The picture for the current time is not decoded yet. */
  waiting: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
};

type Options = {
  track: Mp4VideoTrack;
  /** The sound track, played by `audio` when the browser decodes it. */
  audioTrack: Mp4AudioTrack | null;
  read: ReadBytes;
  /** File size, bounding the reads. */
  size: number;
  canvas: HTMLCanvasElement;
  /** An element without source: it plays the sound and keeps the time. */
  audio: HTMLMediaElement | null;
  onChange: (_state: SoftwarePlaybackState) => void;
  onError: () => void;
  workerUrl?: string;
};

type QueuedFrame = DecodedVideoFrame & { time: number };

const WORKER_URL = "/video-decoders/hevc.worker.js";
const READ_SPAN_BYTES = 1024 * 1024;
const BLOCK_BYTES = 1024 * 1024;
const CACHED_BLOCKS = 24;
const MAX_SAMPLE_BYTES = 16 * 1024 * 1024;
const SAMPLES_PER_MESSAGE = 8;
const MAX_IN_FLIGHT = 8;
const MAX_QUEUED_FRAMES = 12;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
/** Behind by this much, decoding jumps to the next keyframe. */
const LATE_SECONDS = 0.5;
const FIRST_PICTURE_TIMEOUT_MS = 30_000;
const STATE_INTERVAL_MS = 250;

const MATRIX: Record<number, string> = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  9: "bt2020-ncl",
};
const PRIMARIES: Record<number, string> = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  9: "bt2020",
};
const TRANSFER: Record<number, string> = {
  1: "bt709",
  6: "smpte170m",
  13: "iec61966-2-1",
  16: "pq",
  18: "hlg",
};

/**
 * Pictures and sound are read from the same regions of the file, a few
 * seconds apart: cached 1 MiB blocks keep every byte to a single download.
 */
function cachedReads(
  read: ReadBytes,
  size: number,
  lifetime: AbortSignal,
): ReadBytes {
  const cache = createPreviewReadCache(
    CACHED_BLOCKS * BLOCK_BYTES,
    3,
    lifetime,
  );
  return async (start, end, signal) => {
    signal?.throwIfAborted();
    const result = new Uint8Array(end - start);
    const first = Math.floor(start / BLOCK_BYTES);
    const last = Math.floor((end - 1) / BLOCK_BYTES);
    for (let index = first; index <= last; index++) {
      const base = index * BLOCK_BYTES;
      const to = Math.min(size, base + BLOCK_BYTES);
      const bytes = await cache.read(
        String(index),
        async (loadSignal) => {
          const loaded = await read(base, to, loadSignal);
          if (loaded.length !== to - base) throw new Error("Short read");
          return new Uint8Array(loaded);
        },
        signal,
      );
      const from = Math.max(start, base);
      result.set(
        bytes.subarray(from - base, Math.min(end, to) - base),
        from - start,
      );
    }
    return result;
  };
}

export const canDecodeVideoInSoftware = () =>
  typeof Worker === "function" &&
  typeof VideoFrame === "function" &&
  typeof WebAssembly === "object";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFrame = (value: unknown): value is DecodedVideoFrame =>
  isRecord(value) &&
  Number.isFinite(value.timestamp) &&
  Number.isSafeInteger(value.width) &&
  Number.isSafeInteger(value.height) &&
  Number.isSafeInteger(value.codedWidth) &&
  Number.isSafeInteger(value.codedHeight) &&
  (value.width as number) > 0 &&
  (value.height as number) > 0 &&
  (value.codedWidth as number) % 2 === 0 &&
  (value.codedHeight as number) % 2 === 0 &&
  value.data instanceof Uint8Array &&
  value.data.length ===
    ((value.codedWidth as number) * (value.codedHeight as number) * 3) / 2;

export class SoftwareVideoPlayback {
  private readonly track: Mp4VideoTrack;
  private readonly read: ReadBytes;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly onChange: Options["onChange"];
  private readonly onError: Options["onError"];
  private readonly worker: Worker;
  private readonly abort = new AbortController();
  private readAbort = new AbortController();
  private readonly duration: number;
  /** Earliest presentation time among the samples from an index onwards. */
  private readonly earliestFrom: Float64Array;

  private audio: HTMLMediaElement | null = null;
  private sound: MediaSourceAudio | null = null;
  private configured = false;
  private destroyed = false;
  private epoch = 0;
  /** Next sample to send to the worker, in decoding order. */
  private next = 0;
  /** First sample the worker has not decoded yet. */
  private decoded = 0;
  private flushed = false;
  private pumping = false;
  private frames: QueuedFrame[] = [];
  private queuedBytes = 0;
  private shown: QueuedFrame | null = null;
  private playing = false;
  private ended = false;
  /** After a seek: show only the picture of the target time. */
  private settling = false;
  private wallBase = 0;
  private wallStart = 0;
  private colorSpace = true;
  private animation = 0;
  private lastState = "";
  private lastStateAt = 0;
  private firstPicture: ReturnType<typeof setTimeout>;

  constructor(options: Options) {
    this.track = options.track;
    this.read = cachedReads(options.read, options.size, this.abort.signal);
    this.canvas = options.canvas;
    this.onChange = options.onChange;
    this.onError = options.onError;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    this.context = context;

    const { samples } = this.track;
    if (!samples.count) throw new Error("Empty video track");
    this.earliestFrom = new Float64Array(samples.count + 1);
    this.earliestFrom[samples.count] = Infinity;
    for (let i = samples.count - 1; i >= 0; i--)
      this.earliestFrom[i] = Math.min(
        samples.time[i],
        this.earliestFrom[i + 1],
      );
    let last = 0;
    for (let i = 0; i < samples.count; i++)
      last = Math.max(last, samples.time[i]);
    const step = samples.count > 1 ? last / (samples.count - 1) : 0;
    this.duration = Math.max(this.track.duration, last + step);

    const { audio, audioTrack } = options;
    if (audio && audioTrack && canPlayAudioFragments(audioTrack)) {
      this.audio = audio;
      this.sound = new MediaSourceAudio(
        audio,
        audioTrack,
        this.read,
        this.abort.signal,
        this.dropAudio,
      );
      this.audio.addEventListener("error", this.dropAudio);
      this.audio.addEventListener("ended", this.audioEnded);
      this.audio.addEventListener("waiting", this.schedule);
      this.audio.addEventListener("playing", this.schedule);
    }
    this.worker = new Worker(options.workerUrl || WORKER_URL, {
      type: "module",
    });
    this.worker.onmessage = this.receive;
    this.worker.onerror = () => this.fail();
    this.worker.postMessage(
      {
        type: "configure",
        parameterSets: this.track.parameterSets.map(
          (unit) => unit.slice().buffer,
        ),
        nalLengthSize: this.track.nalLengthSize,
      },
      [],
    );
    this.firstPicture = setTimeout(() => {
      if (!this.shown) this.fail();
    }, FIRST_PICTURE_TIMEOUT_MS);
    this.emit(true);
  }

  get currentTime() {
    const time =
      this.audio && !this.audio.ended
        ? this.audio.currentTime
        : this.playing
          ? this.wallBase + (performance.now() - this.wallStart) / 1000
          : this.wallBase;
    return Math.min(Math.max(time, 0), this.duration);
  }

  play() {
    if (this.destroyed || this.playing) return;
    if (this.ended) this.seek(0);
    // Read while still paused: the wall clock has no start time yet.
    this.wallBase = this.currentTime;
    this.wallStart = performance.now();
    this.playing = true;
    this.ended = false;
    this.audio?.play().catch(() => {
      // Refused or failed: the pictures keep their own time.
      if (this.playing) this.dropAudio();
    });
    this.emit(true);
    this.schedule();
  }

  pause() {
    if (!this.playing) return;
    this.wallBase = this.currentTime;
    this.playing = false;
    this.audio?.pause();
    this.emit(true);
  }

  seek(time: number) {
    if (this.destroyed || !Number.isFinite(time)) return;
    const target = Math.min(Math.max(time, 0), this.duration);
    this.ended = false;
    this.wallBase = target;
    this.wallStart = performance.now();
    if (this.audio) this.audio.currentTime = target;
    this.settling = true;
    this.restart(syncSampleBefore(this.track.samples, target));
    this.emit(true);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playing = false;
    clearTimeout(this.firstPicture);
    cancelAnimationFrame(this.animation);
    this.abort.abort();
    this.readAbort.abort();
    this.worker.terminate();
    this.frames = [];
    this.queuedBytes = 0;
    this.sound?.destroy();
    if (this.audio) {
      this.audio.removeEventListener("error", this.dropAudio);
      this.audio.removeEventListener("ended", this.audioEnded);
      this.audio.removeEventListener("waiting", this.schedule);
      this.audio.removeEventListener("playing", this.schedule);
      this.audio.pause();
    }
  }

  private dropAudio = () => {
    if (!this.audio) return;
    this.wallBase = this.currentTime;
    this.wallStart = performance.now();
    this.audio.pause();
    this.audio = null;
    this.sound?.destroy();
    this.sound = null;
    this.schedule();
  };

  /** A shorter sound track: the pictures go on with their own time. */
  private audioEnded = () => {
    if (!this.audio) return;
    this.wallBase = this.audio.currentTime;
    this.wallStart = performance.now();
    this.audio = null;
    this.schedule();
  };

  private fail() {
    if (this.destroyed) return;
    this.destroy();
    this.onError();
  }

  /** Decodes again from `sample`, a keyframe; queued pictures are dropped. */
  private restart(sample: number) {
    this.epoch++;
    this.readAbort.abort();
    this.readAbort = new AbortController();
    this.next = sample;
    this.decoded = sample;
    this.flushed = false;
    this.frames = [];
    this.queuedBytes = 0;
    if (this.configured)
      this.worker.postMessage({ type: "reset", epoch: this.epoch });
    void this.pump();
    this.schedule();
  }

  private receive = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (this.destroyed || !isRecord(message)) return;
    if (message.type === "error") return this.fail();
    if (message.type === "configured") {
      this.configured = true;
      void this.pump();
      return;
    }
    if (message.epoch !== this.epoch) return;
    if (message.type === "frame" && isFrame(message.frame)) {
      this.enqueue(message.frame);
    } else if (
      message.type === "decoded" &&
      Number.isSafeInteger(message.count)
    ) {
      this.decoded = Math.min(
        this.next,
        this.decoded + (message.count as number),
      );
      void this.pump();
    } else if (message.type === "flushed") {
      this.decoded = this.track.samples.count;
    } else return;
    this.schedule();
  };

  private enqueue(frame: DecodedVideoFrame) {
    const queued = { ...frame, time: frame.timestamp / 1e6 };
    // Pictures leave libde265 in decoding order: keep them sorted by time.
    let at = this.frames.length;
    while (at > 0 && this.frames[at - 1].time > queued.time) at--;
    this.frames.splice(at, 0, queued);
    this.queuedBytes += queued.data.length;
    this.prune(this.currentTime);
  }

  /** Drops the pictures a later one, already due, replaces. */
  private prune(time: number) {
    while (this.frames.length > 1 && this.frames[1].time <= time) {
      this.queuedBytes -= this.frames.shift()!.data.length;
    }
  }

  private async pump() {
    if (this.pumping || this.destroyed || !this.configured) return;
    this.pumping = true;
    const { samples } = this.track;
    try {
      while (!this.destroyed) {
        const epoch = this.epoch;
        if (this.next >= samples.count) {
          if (!this.flushed && this.decoded >= samples.count) {
            this.flushed = true;
            this.worker.postMessage({ type: "flush", epoch });
          }
          break;
        }
        const inFlight = this.next - this.decoded;
        if (
          inFlight >= MAX_IN_FLIGHT ||
          this.frames.length + inFlight >= MAX_QUEUED_FRAMES ||
          this.queuedBytes >= MAX_QUEUED_BYTES
        )
          break;
        // One read for consecutive samples close together in the file.
        const first = this.next;
        let start = samples.offset[first];
        let end = start + samples.size[first];
        let last = first + 1;
        while (
          last < samples.count &&
          last - first < SAMPLES_PER_MESSAGE &&
          inFlight + last - first < MAX_IN_FLIGHT
        ) {
          const nextStart = Math.min(start, samples.offset[last]);
          const nextEnd = Math.max(
            end,
            samples.offset[last] + samples.size[last],
          );
          if (nextEnd - nextStart > READ_SPAN_BYTES) break;
          start = nextStart;
          end = nextEnd;
          last++;
        }
        if (end - start > MAX_SAMPLE_BYTES) throw new Error("Sample too large");
        let bytes: Uint8Array;
        try {
          bytes = await this.read(start, end, this.readAbort.signal);
        } catch (error) {
          if (epoch !== this.epoch) continue;
          throw error;
        }
        if (this.destroyed || epoch !== this.epoch) continue;
        if (bytes.length !== end - start) throw new Error("Short read");
        const batch = [];
        for (let i = first; i < last; i++) {
          const at = samples.offset[i] - start;
          batch.push({
            timestamp: Math.round(samples.time[i] * 1e6),
            data: bytes.slice(at, at + samples.size[i]).buffer,
          });
        }
        this.next = last;
        this.worker.postMessage(
          { type: "decode", epoch, samples: batch },
          batch.map((sample) => sample.data),
        );
      }
    } catch {
      if (!this.abort.signal.aborted) this.fail();
    } finally {
      this.pumping = false;
    }
  }

  private schedule = () => {
    if (!this.animation && !this.destroyed)
      this.animation = requestAnimationFrame(this.tick);
  };

  private tick = () => {
    this.animation = 0;
    if (this.destroyed) return;
    const time = this.currentTime;
    this.prune(time);
    const frame = this.frames[0];
    const front = this.earliestFrom[this.decoded];
    // Every picture up to `time` is decoded once nothing earlier is pending.
    const complete = front > time;
    // Before playback starts, the first picture serves as a poster.
    const due =
      frame &&
      frame !== this.shown &&
      (frame.time <= time || !this.shown || (this.settling && complete));
    if (due && (!this.settling || complete)) {
      this.draw(frame);
      this.settling = false;
      void this.pump();
    }
    if (this.playing && front < time - LATE_SECONDS) {
      const keyframe = syncSampleAfter(this.track.samples, time);
      if (keyframe > this.next) this.restart(keyframe);
    }
    if (this.playing && time >= this.duration) {
      this.playing = false;
      this.ended = true;
      this.wallBase = this.duration;
      this.audio?.pause();
    }
    this.emit(false);
    if (this.playing || this.settling || this.waitingAt(time)) this.schedule();
  };

  private waitingAt(time: number) {
    return (
      !this.shown ||
      this.settling ||
      this.earliestFrom[this.decoded] < time - 0.1 ||
      // The sound is buffering: its time, and the pictures, stand still.
      (this.playing &&
        !!this.audio &&
        this.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
    );
  }

  private draw(frame: QueuedFrame) {
    const init = {
      format: "I420" as const,
      codedWidth: frame.codedWidth,
      codedHeight: frame.codedHeight,
      visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
      timestamp: frame.timestamp,
    };
    let picture: VideoFrame;
    try {
      picture = new VideoFrame(
        frame.data,
        this.colorSpace
          ? { ...init, colorSpace: this.colorSpaceOf(frame) }
          : init,
      );
    } catch {
      // Older engines reject some color space names: draw without them.
      this.colorSpace = false;
      picture = new VideoFrame(frame.data, init);
    }
    const rotated = this.track.rotation % 180 !== 0;
    const width = rotated ? frame.height : frame.width;
    const height = rotated ? frame.width : frame.height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.context;
    context.save();
    try {
      context.translate(width / 2, height / 2);
      context.rotate((this.track.rotation * Math.PI) / 180);
      context.drawImage(
        picture,
        -frame.width / 2,
        -frame.height / 2,
        frame.width,
        frame.height,
      );
    } finally {
      context.restore();
      picture.close();
    }
    if (!this.shown) clearTimeout(this.firstPicture);
    this.shown = frame;
  }

  private colorSpaceOf(frame: DecodedVideoFrame) {
    // Unspecified: the usual matrix for the picture size.
    const matrix =
      MATRIX[frame.matrix] || (frame.height >= 720 ? "bt709" : "smpte170m");
    return {
      matrix,
      fullRange: frame.fullRange,
      ...(PRIMARIES[frame.primaries]
        ? { primaries: PRIMARIES[frame.primaries] }
        : {}),
      ...(TRANSFER[frame.transfer]
        ? { transfer: TRANSFER[frame.transfer] }
        : {}),
    } as VideoColorSpaceInit;
  }

  private emit(force: boolean) {
    const now = performance.now();
    const state: SoftwarePlaybackState = {
      ready: Boolean(this.shown),
      playing: this.playing,
      waiting: this.waitingAt(this.currentTime),
      ended: this.ended,
      currentTime: this.currentTime,
      duration: this.duration,
    };
    const key = `${state.ready}${state.playing}${state.waiting}${state.ended}`;
    if (
      !force &&
      key === this.lastState &&
      now - this.lastStateAt < STATE_INTERVAL_MS
    )
      return;
    this.lastState = key;
    this.lastStateAt = now;
    this.onChange(state);
  }
}
