// Plays the videos the browser cannot open itself (AVI, Matroska, WMV, FLV,
// MPEG program and transport streams, old MPEG-4, WMV or MPEG-2 pictures...)
// through the browser's own player: FFmpeg demuxes the file, keeps the
// pictures the browser decodes and re-encodes the others with WebCodecs, the
// sound becomes AAC, and fragmented MP4 goes to MediaSource in the page.
// Sound files the browser cannot play (WMA, AIFF, AMR...) take the same path
// without pictures.
// A module worker served with its own CSP allowing WebAssembly (see
// next.config.js). It reads only the bytes the page sends: keys and
// authorization stay in the page. One worker per video, terminated with it.
// The media/ files are copied here by scripts/build-video-decoders.mjs.
import LibAV from "./media/libav-6.10.9.0-privcloud.mjs";

const READ_BYTES = 1024 * 1024;
const READ_LIMIT = 512 * 1024;
const KEYFRAME_SECONDS = 2;
const REORDER_PACKETS = 16;
const SEEK_BYTE = 2;
const ENCODER_FAILED = new Error("encoder");
const MAX_ENCODE_QUEUE = 8;
const MAX_DIMENSION = 8192;
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
const MOV_FLAGS = "empty_moov+default_base_moof+frag_keyframe";
/** Demuxer to try when probing the bytes finds none, from the file type. */
const FORMAT_HINTS = {
  "video/mpeg": "mpeg",
  "video/mp2t": "mpegts",
  "video/x-msvideo": "avi",
  "video/x-matroska": "matroska",
  "video/webm": "matroska",
  "video/x-ms-wmv": "asf",
  "video/x-ms-asf": "asf",
  "video/x-flv": "flv",
  "video/ogg": "ogg",
  "video/3gpp": "mov",
  "video/quicktime": "mov",
  "video/mp4": "mov",
  "audio/x-ms-wma": "asf",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/x-caf": "caf",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/ac3": "ac3",
  "audio/amr": "amr",
  "audio/ogg": "ogg",
  "audio/mp4": "mov",
};

let libav = null;
let size = 0;
let supported = null;
let fmt = 0;
let packet = 0;
let video = null;
let audio = null;
let duration = 0;
/** Seconds where the file starts: the page's timeline starts at 0. */
let origin = 0;
let epoch = 0;
let want = 0;
let wake = null;
let running = null;
let failed = false;
let readId = 0;
const reads = new Map();

const hasKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const isEpoch = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => Number.isFinite(value) && value >= 0;

function isValid(message) {
  if (!message || typeof message.type !== "string") return false;
  switch (message.type) {
    case "open":
      return (
        hasKeys(message, ["type", "size", "mimeType", "supported"]) &&
        typeof message.mimeType === "string" &&
        Number.isSafeInteger(message.size) &&
        message.size > 0 &&
        hasKeys(message.supported, ["h264", "hevc", "vp9", "av1"]) &&
        Object.values(message.supported).every((on) => typeof on === "boolean")
      );
    case "bytes":
      return (
        Number.isSafeInteger(message.id) &&
        (hasKeys(message, ["type", "id", "data"])
          ? message.data instanceof ArrayBuffer
          : hasKeys(message, ["type", "id", "error"]) && message.error === true)
      );
    case "want":
      return (
        hasKeys(message, ["type", "epoch", "until"]) &&
        isEpoch(message.epoch) &&
        isTime(message.until)
      );
    case "seek":
      return (
        hasKeys(message, ["type", "epoch", "time"]) &&
        isEpoch(message.epoch) &&
        isTime(message.time)
      );
    default:
      return false;
  }
}

function fail(reason) {
  if (failed) return;
  failed = true;
  for (const pending of reads.values()) pending.reject(new Error(reason));
  reads.clear();
  self.postMessage({ type: "error", reason });
}

const seconds = (lo, hi, num, den) =>
  (libav.i64tof64(lo, hi || 0) * num) / den || 0;

const isNoTimestamp = (lo, hi) => lo === 0 && hi === -0x80000000;

/** The page reads and decrypts. Whole MiB windows keep its cache useful. */
function readBytes(start, end) {
  const id = ++readId;
  return new Promise((resolve, reject) => {
    reads.set(id, { resolve, reject, start, end });
    self.postMessage({ type: "read", id, start, end });
  });
}

function onBlockRead(name, position, length) {
  if (name !== "input") return;
  const start = Math.max(0, Math.min(position, size));
  const end = Math.min(
    size,
    Math.max(start + length, Math.floor(start / READ_BYTES + 1) * READ_BYTES),
  );
  if (end <= start) {
    void libav.ff_block_reader_dev_send(name, position, null);
    return;
  }
  readBytes(start, end).then(
    (data) => libav.ff_block_reader_dev_send(name, start, data),
    () => fail("read"),
  );
}

/** Output of the current muxer, sent to the page after each step. */
let output = [];
function onWrite(name, position, buffer) {
  if (name === "output") output.push(new Uint8Array(buffer).slice());
}

function sendOutput(state) {
  if (!output.length) return;
  const total = output.reduce((sum, part) => sum + part.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of output) {
    data.set(part, at);
    at += part.length;
  }
  output = [];
  self.postMessage(
    {
      type: "data",
      epoch: state.epoch,
      // Never negative: WebKit drops samples decoded before 0 (B-frames).
      base: Math.max(0, state.base - origin),
      until: state.until - origin,
      data: data.buffer,
    },
    [data.buffer],
  );
}

function avcCodec(width, height) {
  const area = width * height;
  const level = area <= 921600 ? "1f" : area <= 2228224 ? "2a" : "33";
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}

/** libav.js names codecs, FFmpeg numbers them. */
async function codecId(name) {
  const descriptor = await libav.avcodec_descriptor_get_by_name(name);
  if (!descriptor) throw new Error("codec");
  return libav.AVCodecDescriptor_id(descriptor);
}

/** Encoder configurations this browser accepts for these pictures. */
async function encoderConfigs(width, height, rate) {
  const accepted = [];
  if (typeof VideoEncoder !== "function") return accepted;
  const bitrate = Math.round(
    Math.min(20e6, Math.max(1.5e6, width * height * rate * 0.12)),
  );
  const candidates = [
    ...avcCodec(width, height).map((codec) => ({
      codec,
      avc: { format: "avc" },
    })),
    { codec: "vp09.00.40.08" },
  ];
  for (const candidate of candidates) {
    const config = {
      ...candidate,
      width,
      height,
      bitrate,
      framerate: rate,
      // Fast enough to stay ahead of playback with software encoders.
      latencyMode: "realtime",
    };
    try {
      const { supported: ok } = await VideoEncoder.isConfigSupported(config);
      if (ok) accepted.push(config);
    } catch {
      // An engine that rejects the codec string goes on with the next one.
    }
  }
  return accepted;
}

async function open(message) {
  size = message.size;
  supported = message.supported;
  libav = await LibAV.LibAV({ noworker: true, nothreads: true });
  libav.onblockread = onBlockRead;
  libav.onwrite = onWrite;
  await libav.mkblockreaderdev("input", size);
  await libav.mkwriterdev("output");
  const hint = Object.prototype.hasOwnProperty.call(
    FORMAT_HINTS,
    message.mimeType,
  )
    ? FORMAT_HINTS[message.mimeType]
    : null;
  const [context, streams] = await libav
    .ff_init_demuxer_file("input")
    .catch((error) => {
      if (!hint) throw error;
      return libav.ff_init_demuxer_file("input", hint);
    });
  fmt = context;
  packet = await libav.av_packet_alloc();
  const first = (type) =>
    streams.find((stream) => stream.codec_type === type) || null;
  const videoStream = first(libav.AVMEDIA_TYPE_VIDEO);
  const audioStream = first(libav.AVMEDIA_TYPE_AUDIO);
  if (!videoStream && !audioStream) throw new Error("unsupported");
  const microseconds = async (lo, hi) => {
    const low = await libav[lo](fmt);
    const high = await libav[hi](fmt);
    return isNoTimestamp(low, high) ? 0 : libav.i64tof64(low, high) / 1e6;
  };
  origin = Math.max(
    0,
    await microseconds(
      "AVFormatContext_start_time",
      "AVFormatContext_start_timehi",
    ),
  );
  duration = Math.max(
    ...streams.map((stream) => stream.duration || 0),
    await microseconds(
      "AVFormatContext_duration",
      "AVFormatContext_durationhi",
    ),
  );

  if (videoStream) await openVideo(videoStream);
  if (audioStream) {
    const audioParameters = await libav.ff_copyout_codecpar(
      audioStream.codecpar,
    );
    if (AAC_RATES.includes(audioParameters.sample_rate))
      audio = {
        stream: audioStream,
        rate: audioParameters.sample_rate,
        channels: Math.min(2, Math.max(1, audioParameters.channels || 2)),
      };
  }
  if (!video && !audio) throw new Error("unsupported");
  self.postMessage({ type: "ready", duration, hasAudio: !!audio });
}

async function openVideo(videoStream) {
  const parameters = await libav.ff_copyout_codecpar(videoStream.codecpar);
  const copy =
    supported[
      { h264: "h264", hevc: "hevc", vp9: "vp9", av1: "av1" }[
        await libav.avcodec_get_name(videoStream.codec_id)
      ]
    ] === true;
  video = {
    stream: videoStream,
    copy,
    width: parameters.width,
    height: parameters.height,
  };
  if (!copy) {
    const width = parameters.width & ~1;
    const height = parameters.height & ~1;
    if (
      !(
        width > 0 &&
        height > 0 &&
        width <= MAX_DIMENSION &&
        height <= MAX_DIMENSION
      )
    )
      throw new Error("unsupported");
    video.configs = await encoderConfigs(width, height, 30);
    if (!video.configs.length) throw new Error("unsupported");
    video.config = video.configs[0];
    video.width = width;
    video.height = height;
  }
}

/** Converts decoded sound of any layout to planar float, mono or stereo. */
function planarFloat(frame, channels) {
  const { data, format, nb_samples: count } = frame;
  const planes = Array.isArray(data);
  const sourceChannels = planes ? data.length : frame.channels || 1;
  const scale =
    format === libav.AV_SAMPLE_FMT_S16 || format === libav.AV_SAMPLE_FMT_S16P
      ? 1 / 32768
      : format === libav.AV_SAMPLE_FMT_S32 ||
          format === libav.AV_SAMPLE_FMT_S32P
        ? 1 / 2147483648
        : format === libav.AV_SAMPLE_FMT_U8 ||
            format === libav.AV_SAMPLE_FMT_U8P
          ? 1 / 128
          : 1;
  const offset =
    format === libav.AV_SAMPLE_FMT_U8 || format === libav.AV_SAMPLE_FMT_U8P
      ? 128
      : 0;
  const sample = (channel, index) =>
    ((planes ? data[channel][index] : data[index * sourceChannels + channel]) -
      offset) *
    scale;
  const out = Array.from({ length: channels }, () => new Float32Array(count));
  for (let i = 0; i < count; i++) {
    if (sourceChannels === 1) {
      for (let c = 0; c < channels; c++) out[c][i] = sample(0, i);
    } else if (channels === 1) {
      out[0][i] = (sample(0, i) + sample(1, i)) / 2;
    } else if (sourceChannels >= 6) {
      // 5.1 and wider, in FFmpeg's order: FL FR FC LFE BL BR...
      const center = sample(2, i) * 0.707;
      out[0][i] = sample(0, i) + center + sample(4, i) * 0.707;
      out[1][i] = sample(1, i) + center + sample(5, i) * 0.707;
    } else {
      out[0][i] = sample(0, i);
      out[1][i] = sample(1, i);
    }
  }
  return out;
}

/** One pipeline from a keyframe: demuxing to the muxer's output. */
async function createPipeline(state) {
  const streams = [];
  if (video?.copy) {
    streams.push({
      codecpar: video.stream.codecpar,
      num: video.stream.time_base_num,
      den: video.stream.time_base_den,
    });
  } else if (video) {
    const [, decoder, decodePacket, decodeFrame] = await libav.ff_init_decoder(
      video.stream.codec_id,
      {
        codecpar: video.stream.codecpar,
        time_base: [video.stream.time_base_num, video.stream.time_base_den],
      },
    );
    state.videoDecoder = { decoder, decodePacket, decodeFrame };
    state.chunks = [];
    state.description = null;
    state.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (metadata?.decoderConfig?.description && !state.description)
          state.description = new Uint8Array(
            ArrayBuffer.isView(metadata.decoderConfig.description)
              ? metadata.decoderConfig.description.buffer.slice(
                  metadata.decoderConfig.description.byteOffset,
                  metadata.decoderConfig.description.byteOffset +
                    metadata.decoderConfig.description.byteLength,
                )
              : metadata.decoderConfig.description.slice(0),
          );
        video.encoded = true;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        state.chunks.push({
          data,
          timestamp: chunk.timestamp,
          key: chunk.type === "key",
        });
      },
      error: () => {
        state.encodeFailed = true;
      },
    });
    state.encoder.configure(video.config);
    state.lastKey = -Infinity;
  }
  if (audio) {
    const [, decoder, decodePacket, decodeFrame] = await libav.ff_init_decoder(
      audio.stream.codec_id,
      {
        codecpar: audio.stream.codecpar,
        time_base: [audio.stream.time_base_num, audio.stream.time_base_den],
      },
    );
    const [, encoder, encodeFrame, encodePacket, frameSize] =
      await libav.ff_init_encoder("aac", {
        ctx: {
          bit_rate: 160000,
          sample_fmt: libav.AV_SAMPLE_FMT_FLTP,
          sample_rate: audio.rate,
          channel_layout: audio.channels === 1 ? 4 : 3,
          channels: audio.channels,
        },
        time_base: [1, audio.rate],
      });
    state.audioCoder = {
      decoder,
      decodePacket,
      decodeFrame,
      encoder,
      encodeFrame,
      encodePacket,
      frameSize: frameSize || 1024,
      pending: Array.from(
        { length: audio.channels },
        () => new Float32Array(0),
      ),
      next: null,
    };
  }
  state.streams = streams;
  state.queued = { audio: [] };
  state.copied = [];
  state.reorder = [];
  state.presentation = [];
  return state;
}

/**
 * Copied pictures go to the muxer a few packets late: Matroska and others
 * give presentation times only, and the decode times are those same times in
 * increasing order. Given decode times stay, kept strictly increasing.
 */
function releaseCopied(state, ended) {
  const { time_base_num: num, time_base_den: den } = video.stream;
  while (
    state.reorder.length > REORDER_PACKETS ||
    (ended && state.reorder.length)
  ) {
    const { item, pts, dts } = state.reorder.shift();
    const earliest = state.presentation.shift();
    let decode = dts ?? earliest;
    if (state.lastDts !== undefined && decode <= state.lastDts)
      decode = state.lastDts + 1;
    state.lastDts = decode;
    // Equal presentation times: one tick later rather than a dropped packet.
    const [ptsLo, ptsHi] = libav.f64toi64(Math.max(pts, decode));
    const [dtsLo, dtsHi] = libav.f64toi64(decode);
    state.copied.push({
      ...item,
      pts: ptsLo,
      ptshi: ptsHi,
      dts: dtsLo,
      dtshi: dtsHi,
      stream_index: 0,
      // Rescaled by the muxer, which picks its own time base.
      time_base_num: num,
      time_base_den: den,
    });
  }
}

/** Writes what is ready, once the muxer knows every stream. */
async function drain(state, ended) {
  if (!state.oc) {
    const known =
      !video ||
      video.copy ||
      state.description ||
      (!video.config.avc && state.chunks.length);
    if (!known) return;
    await startMuxer(state);
  }
  const ready = !video
    ? []
    : video.copy
      ? state.copied.splice(0)
      : takeVideoChunks(state);
  ready.push(...state.queued.audio.splice(0));
  await writePackets(state, ready);
  if (ended) {
    await libav.av_write_trailer(state.oc);
    await libav.avio_flush(state.pb);
  }
  sendOutput(state);
}

async function startMuxer(state) {
  const pars = [];
  if (video?.copy) {
    pars.push([
      video.stream.codecpar,
      video.stream.time_base_num,
      video.stream.time_base_den,
    ]);
  } else if (video) {
    const par = await libav.avcodec_parameters_alloc();
    await libav.ff_copyin_codecpar(par, {
      codec_type: libav.AVMEDIA_TYPE_VIDEO,
      codec_id: video.config.codec.startsWith("vp09")
        ? await codecId("vp9")
        : await codecId("h264"),
      width: video.width,
      height: video.height,
      format: libav.AV_PIX_FMT_YUV420P,
      extradata: state.description || undefined,
    });
    state.ownedPars = [par];
    pars.push([par, 1, 1_000_000]);
  }
  if (state.audioCoder) {
    const par = await libav.avcodec_parameters_alloc();
    await libav.avcodec_parameters_from_context(par, state.audioCoder.encoder);
    (state.ownedPars ||= []).push(par);
    pars.push([par, 1, audio.rate]);
  }
  const [oc, , pb] = await libav.ff_init_muxer(
    { format_name: "mp4", filename: "output", open: true, codecpars: true },
    pars,
  );
  // Searched in the children: these are options of the MP4 muxer itself.
  if (
    (await libav.av_opt_set(oc, "movflags", MOV_FLAGS, 1)) < 0 ||
    (await libav.av_opt_set(oc, "frag_duration", "1000000", 1)) < 0
  )
    throw new Error("muxer options");
  const header = await libav.avformat_write_header(oc, 0);
  if (header < 0) throw new Error("muxer header");
  state.oc = oc;
  state.pb = pb;
  state.muxPacket = await libav.av_packet_alloc();
}

async function writePackets(state, packets) {
  if (!packets.length) return;
  await libav.ff_write_multi(state.oc, state.muxPacket, packets, true);
  await libav.avio_flush(state.pb);
}

async function encodeVideo(state, frame) {
  const time = seconds(
    frame.pts,
    frame.ptshi,
    video.stream.time_base_num,
    video.stream.time_base_den,
  );
  const layout = frame.layout;
  const picture = new VideoFrame(frame.data, {
    format: "I420",
    codedWidth: frame.width,
    codedHeight: frame.height,
    visibleRect: { x: 0, y: 0, width: video.width, height: video.height },
    timestamp: Math.max(0, Math.round((time - state.base) * 1e6)),
    layout: layout.slice(0, 3),
  });
  const key = time - state.lastKey >= KEYFRAME_SECONDS;
  if (key) state.lastKey = time;
  if (state.encodeFailed || state.encoder.state !== "configured") {
    picture.close();
    throw ENCODER_FAILED;
  }
  while (
    state.encoder.state === "configured" &&
    state.encoder.encodeQueueSize > MAX_ENCODE_QUEUE
  )
    await new Promise((resolve) =>
      state.encoder.addEventListener("dequeue", resolve, { once: true }),
    );
  try {
    // Closed meanwhile by a failure: reported once its callback ran.
    state.encoder.encode(picture, { keyFrame: key });
  } catch {
    throw ENCODER_FAILED;
  } finally {
    picture.close();
  }
  state.until = Math.max(state.until, time);
}

async function decodeVideo(state, packets, fin) {
  const coder = state.videoDecoder;
  const frames = await libav.ff_decode_multi(
    coder.decoder,
    coder.decodePacket,
    coder.decodeFrame,
    packets,
    { fin, ignoreErrors: true, copyoutFrame: "ptr" },
  );
  for (const pointer of frames) {
    try {
      const format = await libav.AVFrame_format(pointer);
      let source = pointer;
      if (
        format !== libav.AV_PIX_FMT_YUV420P &&
        format !== libav.AV_PIX_FMT_YUVJ420P
      ) {
        const width = await libav.AVFrame_width(pointer);
        const height = await libav.AVFrame_height(pointer);
        if (!state.sws || state.swsKey !== `${format}:${width}:${height}`) {
          if (state.sws) await libav.sws_freeContext(state.sws);
          state.sws = await libav.sws_getContext(
            width,
            height,
            format,
            width,
            height,
            libav.AV_PIX_FMT_YUV420P,
            2,
            0,
            0,
            0,
          );
          state.swsKey = `${format}:${width}:${height}`;
          state.swsFrame ||= await libav.av_frame_alloc();
        }
        await libav.av_frame_unref(state.swsFrame);
        await libav.sws_scale_frame(state.sws, state.swsFrame, pointer);
        await libav.AVFrame_pts_s(
          state.swsFrame,
          await libav.AVFrame_pts(pointer),
        );
        await libav.AVFrame_ptshi_s(
          state.swsFrame,
          await libav.AVFrame_ptshi(pointer),
        );
        source = state.swsFrame;
      }
      const best = await libav.AVFrame_best_effort_timestamp(pointer);
      const bestHi = await libav.AVFrame_best_effort_timestamphi(pointer);
      // The exported copy takes the width, the internal one reads it.
      const frame = await libav.ff_copyout_frame_video(
        source,
        await libav.AVFrame_width(source),
      );
      if (!isNoTimestamp(best, bestHi)) {
        frame.pts = best;
        frame.ptshi = bestHi;
      }
      if (epoch === state.epoch) await encodeVideo(state, frame);
    } finally {
      await libav.av_frame_free_js(pointer);
    }
  }
}

async function codeAudio(state, packets, fin) {
  const coder = state.audioCoder;
  const frames = await libav.ff_decode_multi(
    coder.decoder,
    coder.decodePacket,
    coder.decodeFrame,
    packets,
    { fin, ignoreErrors: true },
  );
  const out = [];
  for (const frame of frames) {
    if (!frame.nb_samples) continue;
    if (coder.next === null) {
      const time = isNoTimestamp(frame.pts, frame.ptshi)
        ? state.base
        : seconds(
            frame.pts,
            frame.ptshi,
            audio.stream.time_base_num,
            audio.stream.time_base_den,
          );
      coder.next = Math.max(0, Math.round((time - state.base) * audio.rate));
    }
    const planes = planarFloat(frame, audio.channels);
    coder.pending = coder.pending.map((pending, c) => {
      const grown = new Float32Array(pending.length + planes[c].length);
      grown.set(pending);
      grown.set(planes[c], pending.length);
      return grown;
    });
  }
  const toEncode = [];
  while (
    coder.pending[0].length >= coder.frameSize ||
    (fin && coder.pending[0].length)
  ) {
    const count = Math.min(coder.frameSize, coder.pending[0].length);
    toEncode.push({
      data: coder.pending.map((pending) => pending.slice(0, count)),
      format: libav.AV_SAMPLE_FMT_FLTP,
      channel_layout: audio.channels === 1 ? 4 : 3,
      channels: audio.channels,
      sample_rate: audio.rate,
      nb_samples: count,
      pts: coder.next,
    });
    coder.next += count;
    coder.pending = coder.pending.map((pending) => pending.slice(count));
  }
  if (toEncode.length || fin) {
    const encoded = await libav.ff_encode_multi(
      coder.encoder,
      coder.encodeFrame,
      coder.encodePacket,
      toEncode,
      fin,
    );
    for (const item of encoded) {
      item.stream_index = video ? 1 : 0;
      item.time_base_num = 1;
      item.time_base_den = audio.rate;
      out.push(item);
    }
  }
  return out;
}

function takeVideoChunks(state) {
  const packets = [];
  for (const chunk of state.chunks.splice(0)) {
    const [lo, hi] = libav.f64toi64(chunk.timestamp);
    let dts = chunk.timestamp;
    if (state.lastDts !== undefined && dts <= state.lastDts)
      dts = state.lastDts + 1;
    state.lastDts = dts;
    const [dlo, dhi] = libav.f64toi64(dts);
    packets.push({
      data: chunk.data,
      pts: lo,
      ptshi: hi,
      dts: dlo,
      dtshi: dhi,
      stream_index: 0,
      time_base_num: 1,
      time_base_den: 1_000_000,
      flags: chunk.key ? 1 : 0,
    });
  }
  return packets;
}

async function closePipeline(state) {
  try {
    if (state.encoder && state.encoder.state !== "closed")
      state.encoder.close();
  } catch {
    // Already closed by an error.
  }
  if (state.videoDecoder)
    await libav.ff_free_decoder(
      state.videoDecoder.decoder,
      state.videoDecoder.decodePacket,
      state.videoDecoder.decodeFrame,
    );
  if (state.audioCoder) {
    const coder = state.audioCoder;
    await libav.ff_free_decoder(
      coder.decoder,
      coder.decodePacket,
      coder.decodeFrame,
    );
    await libav.ff_free_encoder(
      coder.encoder,
      coder.encodeFrame,
      coder.encodePacket,
    );
  }
  if (state.sws) await libav.sws_freeContext(state.sws);
  if (state.swsFrame) await libav.av_frame_free_js(state.swsFrame);
  if (state.oc) await libav.ff_free_muxer(state.oc, state.pb);
  if (state.muxPacket) await libav.av_packet_free_js(state.muxPacket);
  for (const par of state.ownedPars || [])
    await libav.avcodec_parameters_free_js(par);
  output = [];
}

async function run(myEpoch, time) {
  if (time > 0) {
    const [lo, hi] = libav.f64toi64(Math.round((time + origin) * 1e6));
    await libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
  } else {
    // Back to the first byte: a timestamp search may land on a later
    // keyframe in streams without an index (MPEG-TS, FLV).
    await libav.avformat_seek_file_max(fmt, -1, 0, 0, SEEK_BYTE);
  }
  const state = await createPipeline({ epoch: myEpoch, base: null, until: 0 });
  try {
    let ended = false;
    while (myEpoch === epoch && !failed) {
      if ((state.base !== null && state.until >= want) || ended) {
        // Pictures still in the encoder reach the page before it waits.
        if (state.encodeFailed) throw ENCODER_FAILED;
        if (state.encoder?.state === "configured")
          await state.encoder.flush().catch(() => {
            throw ENCODER_FAILED;
          });
        if (myEpoch !== epoch) break;
        await drain(state, ended);
        if (ended) {
          self.postMessage({ type: "end", epoch: myEpoch });
          break;
        }
        await new Promise((resolve) => (wake = resolve));
        continue;
      }
      const [result, byStream] = await libav.ff_read_frame_multi(fmt, packet, {
        limit: READ_LIMIT,
      });
      if (myEpoch !== epoch) break;
      ended = result === libav.AVERROR_EOF;
      if (result < 0 && !ended && result !== -libav.EAGAIN)
        throw new Error("demux");
      const videoPackets = video ? byStream[video.stream.index] || [] : [];
      const audioPackets = audio ? byStream[audio.stream.index] || [] : [];
      if (state.base === null && !video) {
        const first = audioPackets.find(
          (item) => !isNoTimestamp(item.pts, item.ptshi),
        );
        if (!first) {
          if (ended) break;
          continue;
        }
        state.base = audioTime(first);
      } else if (state.base === null) {
        const first = videoPackets.find((item) => item.flags & 1) || null;
        if (!first) {
          if (ended) break;
          continue;
        }
        const useDts = !isNoTimestamp(first.dts, first.dtshi);
        state.base = seconds(
          useDts ? first.dts : first.pts,
          useDts ? first.dtshi : first.ptshi,
          video.stream.time_base_num,
          video.stream.time_base_den,
        );
        videoPackets.splice(0, videoPackets.indexOf(first));
      }
      if (video?.copy) {
        const { time_base_num: num, time_base_den: den } = video.stream;
        const offset = Math.round((state.base * den) / num);
        for (const item of videoPackets) {
          const noDts = isNoTimestamp(item.dts, item.dtshi);
          const noPts = isNoTimestamp(item.pts, item.ptshi);
          if (noDts && noPts) continue;
          const dts = noDts
            ? null
            : libav.i64tof64(item.dts, item.dtshi) - offset;
          const pts = noPts
            ? dts
            : libav.i64tof64(item.pts, item.ptshi) - offset;
          state.until = Math.max(state.until, state.base + (pts * num) / den);
          state.reorder.push({ item, pts, dts });
          const at = state.presentation.findIndex((value) => value > pts);
          state.presentation.splice(
            at < 0 ? state.presentation.length : at,
            0,
            pts,
          );
        }
        releaseCopied(state, ended);
      } else if (video) {
        await decodeVideo(state, videoPackets, ended);
        if (ended)
          await state.encoder.flush().catch(() => {
            throw ENCODER_FAILED;
          });
      }
      if (state.audioCoder) {
        const keep = audioPackets.filter(
          (item) =>
            isNoTimestamp(item.pts, item.ptshi) ||
            audioTime(item) >= state.base,
        );
        // Without pictures, the sound decides how far the pipeline went.
        if (!video)
          for (const item of keep)
            if (!isNoTimestamp(item.pts, item.ptshi))
              state.until = Math.max(state.until, audioTime(item));
        state.queued.audio.push(...(await codeAudio(state, keep, ended)));
      }
      if (myEpoch !== epoch) break;
      await drain(state, false);
    }
  } finally {
    await closePipeline(state);
  }
}

function audioTime(item) {
  return seconds(
    item.pts,
    item.ptshi,
    audio.stream.time_base_num,
    audio.stream.time_base_den,
  );
}

function restart(nextEpoch, time) {
  epoch = nextEpoch;
  want = Math.max(want, time + origin);
  wake?.();
  wake = null;
  const previous = running || Promise.resolve();
  running = previous
    .catch(() => undefined)
    .then(() => (epoch === nextEpoch ? attempt(nextEpoch, time) : undefined))
    .catch((error) => fail(error === ENCODER_FAILED ? "encode" : "decode"));
}

/**
 * An encoder can be announced and still fail on its first picture (a system
 * H.264 encoder missing in Firefox, for one): the next accepted one takes
 * over from the same position.
 */
function attempt(myEpoch, time) {
  return run(myEpoch, time).catch((error) => {
    if (error !== ENCODER_FAILED || video.encoded || video.configs.length < 2)
      throw error;
    // The other profiles of a failing codec share its missing encoder.
    const family = video.config.codec.slice(0, 4);
    video.configs = video.configs.filter(
      (config) => !config.codec.startsWith(family),
    );
    if (!video.configs.length) throw error;
    video.config = video.configs[0];
    return epoch === myEpoch ? attempt(myEpoch, time) : undefined;
  });
}

self.onmessage = (event) => {
  if (
    !event.isTrusted ||
    event.origin !== "" ||
    event.source !== null ||
    event.ports.length ||
    failed ||
    !isValid(event.data)
  )
    return;
  const message = event.data;
  if (message.type === "open") {
    if (libav) return;
    open(message).catch((error) =>
      fail(error?.message === "unsupported" ? "unsupported" : "open"),
    );
  } else if (message.type === "bytes") {
    const pending = reads.get(message.id);
    if (!pending) return;
    reads.delete(message.id);
    if (
      message.error ||
      message.data.byteLength !== pending.end - pending.start
    )
      pending.reject(new Error("read"));
    else pending.resolve(new Uint8Array(message.data));
  } else if (message.type === "seek") {
    if (!libav || !fmt || message.epoch <= epoch) return;
    want = 0;
    restart(message.epoch, message.time);
  } else if (message.type === "want") {
    if (message.epoch !== epoch || !fmt) return;
    want = message.until + origin;
    if (!running) restart(epoch, 0);
    wake?.();
    wake = null;
  }
};
