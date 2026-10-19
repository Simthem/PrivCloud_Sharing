// HEVC decoding core of public/video-decoders/hevc.worker.js, transpiled to
// hevc-core.mjs by scripts/build-video-decoders.mjs. Imports nothing: it only
// drives the libde265 module the worker hands over.

type Plane = {
  width: number;
  height: number;
  bytes: Uint8Array;
  stride: number;
};

type Picture = {
  readonly chromaFormat: number;
  readonly isFullRange: boolean;
  readonly colorPrimaries: number;
  readonly transferCharacteristics: number;
  readonly matrixCoefficients: number;
  readonly pts: bigint;
  getBitsPerPixel(_channel: number): number;
  getImagePlane(_channel: number): Plane;
  delete(): void;
};

type Decoder = {
  pushNal(_nal: Uint8Array, _pts: bigint): number;
  pushEndOfFrame(): void;
  flushData(): number;
  decode(): { error: number; more: boolean };
  getNextPicture(): Picture | null;
  reset(): void;
  delete(): void;
};

export type Libde265 = {
  Decoder: new () => Decoder;
  Error: { ERROR_WAITING_FOR_INPUT_DATA: number };
  isOk(_error: number): boolean;
};

/**
 * A picture as packed 8-bit I420, timestamp in microseconds. The coded size is
 * the visible one rounded up to even, as VideoFrame requires for I420.
 */
export type DecodedVideoFrame = {
  timestamp: number;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  data: Uint8Array;
  fullRange: boolean;
  matrix: number;
  primaries: number;
  transfer: number;
};

const MAX_PICTURE_PIXELS = 8192 * 4320;

/** Copies a plane into `out`, resampled to width x height, as 8 bits. */
function copyPlane(
  plane: Plane,
  bits: number,
  out: Uint8Array,
  at: number,
  width: number,
  height: number,
  outStride: number,
) {
  const stepX = Math.max(1, Math.round(plane.width / width));
  const stepY = Math.max(1, Math.round(plane.height / height));
  const { stride } = plane;
  // The binding sizes this view as width x height x bits / 8, ignoring the
  // stride and the two bytes a deeper sample takes: the last rows fall
  // outside it. It does point into the module memory, where they are.
  const needed = stride * (plane.height - 1) + plane.width * (bits > 8 ? 2 : 1);
  let bytes = plane.bytes;
  if (bytes.length < needed) {
    if (bytes.byteOffset + needed > bytes.buffer.byteLength)
      throw new Error("Picture plane outside decoder memory");
    bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, needed);
  }
  if (bits === 8 && stepX === 1) {
    for (let y = 0; y < height; y++) {
      const row = Math.min(y * stepY, plane.height - 1) * stride;
      out.set(bytes.subarray(row, row + width), at + y * outStride);
    }
    return;
  }
  const wide = bits > 8;
  const shift = bits - 8;
  for (let y = 0; y < height; y++) {
    const row = Math.min(y * stepY, plane.height - 1) * stride;
    const target = at + y * outStride;
    for (let x = 0; x < width; x++) {
      const column = Math.min(x * stepX, plane.width - 1);
      out[target + x] = wide
        ? (bytes[row + column * 2] | (bytes[row + column * 2 + 1] << 8)) >>
          shift
        : bytes[row + column];
    }
  }
}

function toI420(picture: Picture): DecodedVideoFrame {
  const luma = picture.getImagePlane(0);
  const { width, height } = luma;
  const bits = picture.getBitsPerPixel(0);
  if (
    width < 1 ||
    height < 1 ||
    width * height > MAX_PICTURE_PIXELS ||
    bits < 8 ||
    bits > 16
  )
    throw new Error("Unsupported picture");
  const codedWidth = width + (width & 1);
  const codedHeight = height + (height & 1);
  const chromaWidth = codedWidth >> 1;
  const chromaHeight = codedHeight >> 1;
  const chromaSize = chromaWidth * chromaHeight;
  const lumaSize = codedWidth * codedHeight;
  const data = new Uint8Array(lumaSize + 2 * chromaSize);
  copyPlane(luma, bits, data, 0, width, height, codedWidth);
  for (const channel of [1, 2]) {
    const at = lumaSize + (channel - 1) * chromaSize;
    // Monochrome pictures have no chroma: neutral grey.
    if (picture.chromaFormat === 0) data.fill(128, at, at + chromaSize);
    else
      copyPlane(
        picture.getImagePlane(channel),
        picture.getBitsPerPixel(channel),
        data,
        at,
        chromaWidth,
        chromaHeight,
        chromaWidth,
      );
  }
  return {
    timestamp: Number(picture.pts),
    width,
    height,
    codedWidth,
    codedHeight,
    data,
    fullRange: picture.isFullRange,
    matrix: picture.matrixCoefficients,
    primaries: picture.colorPrimaries,
    transfer: picture.transferCharacteristics,
  };
}

export type HevcSample = { timestamp: number; data: Uint8Array };

/**
 * Decodes MP4 samples (length-prefixed NAL units) in decoding order and
 * returns pictures in presentation order.
 */
export function createHevcDecoder(
  library: Libde265,
  parameterSets: Uint8Array[],
  nalLengthSize: number,
) {
  if (![1, 2, 4].includes(nalLengthSize) || !parameterSets.length)
    throw new Error("Invalid HEVC configuration");
  const decoder = new library.Decoder();
  const pushParameterSets = () => {
    for (const unit of parameterSets) decoder.pushNal(unit, BigInt(0));
  };
  pushParameterSets();

  const drain = (frames: DecodedVideoFrame[]) => {
    for (let more = true; more; ) {
      const result = decoder.decode();
      more = result.more;
      for (
        let picture = decoder.getNextPicture();
        picture;
        picture = decoder.getNextPicture()
      ) {
        try {
          frames.push(toI420(picture));
        } finally {
          picture.delete();
        }
      }
      if (result.error === library.Error.ERROR_WAITING_FOR_INPUT_DATA) return;
      if (!library.isOk(result.error)) throw new Error("HEVC decoding failed");
    }
  };

  return {
    decode(samples: HevcSample[]) {
      const frames: DecodedVideoFrame[] = [];
      for (const { timestamp, data } of samples) {
        const pts = BigInt(Math.round(timestamp));
        for (let at = 0; at < data.length; ) {
          if (at + nalLengthSize > data.length)
            throw new Error("Truncated NAL unit");
          let length = 0;
          for (let i = 0; i < nalLengthSize; i++)
            length = length * 256 + data[at + i];
          at += nalLengthSize;
          if (length < 1 || at + length > data.length)
            throw new Error("Truncated NAL unit");
          decoder.pushNal(data.subarray(at, at + length), pts);
          at += length;
        }
        decoder.pushEndOfFrame();
        drain(frames);
      }
      return frames;
    },
    /** Returns the pictures still held for reordering. */
    flush() {
      const frames: DecodedVideoFrame[] = [];
      decoder.flushData();
      drain(frames);
      return frames;
    },
    /** Forgets every reference picture, before decoding from a new keyframe. */
    reset() {
      decoder.reset();
      pushParameterSets();
    },
    close() {
      decoder.delete();
    },
  };
}
