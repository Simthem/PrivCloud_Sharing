import type { DecodedStillImage } from "./imageDecoderCore.util";
import { imageDecoderFormat, orientationTransform } from "./imageFormats.util";

/** Longest side of a decoded preview: sharp on screen, bounded in memory. */
export const DECODED_PREVIEW_MAX_SIDE = 4096;

const abortError = () => new DOMException("Aborted", "AbortError");

function runDecoder(
  format: string,
  bytes: ArrayBuffer,
  maxSide: number,
  signal?: AbortSignal,
): Promise<DecodedStillImage> {
  if (signal?.aborted) return Promise.reject(abortError());
  const worker = new Worker("/image-decoders/decoder.worker.js");
  return new Promise<DecodedStillImage>((resolve, reject) => {
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      finish();
      const message = event.data;
      if (message?.id === 1 && message.type === "result") {
        resolve(message.result);
      } else {
        reject(new Error("Image decoding failed"));
      }
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Image decoder unavailable"));
    };
    worker.postMessage({ id: 1, type: "decode", format, bytes, maxSide }, [
      bytes,
    ]);
  });
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Encoding failed"))),
      type,
      type === "image/jpeg" ? 0.92 : undefined,
    ),
  );

async function drawUpright(
  source: CanvasImageSource,
  width: number,
  height: number,
  orientation: number,
  type: string,
): Promise<Blob> {
  const scale = Math.min(1, DECODED_PREVIEW_MAX_SIDE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const upright = orientationTransform(orientation, targetWidth, targetHeight);
  const canvas = document.createElement("canvas");
  canvas.width = upright.width;
  canvas.height = upright.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.setTransform(...upright.matrix);
  context.drawImage(source, 0, 0, targetWidth, targetHeight);
  try {
    return await canvasBlob(canvas, type);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/**
 * An image any <img> can show. Browser formats pass through untouched; HEIC,
 * TIFF and RAW are decoded on the device, so E2E content never leaves it.
 * Consumes `bytes`, which is transferred to the decoder.
 */
export async function toDisplayableImageBlob(
  bytes: ArrayBuffer,
  mimeType: string,
  signal?: AbortSignal,
  maxSide = DECODED_PREVIEW_MAX_SIDE,
): Promise<Blob> {
  const format = imageDecoderFormat(mimeType);
  if (!format) return new Blob([bytes], { type: mimeType });

  const decoded = await runDecoder(format, bytes, maxSide, signal);
  return toDisplayableDecodedImageBlob(decoded, signal);
}

/** Render an already extracted camera JPEG without starting a RAW decoder. */
export async function toDisplayableDecodedImageBlob(
  decoded: DecodedStillImage,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  if (decoded.kind === "jpeg") {
    const jpeg = new Blob([decoded.bytes as Uint8Array<ArrayBuffer>], {
      type: "image/jpeg",
    });
    if (decoded.orientation === 1) return jpeg;
    const bitmap = await createImageBitmap(jpeg);
    try {
      signal?.throwIfAborted();
      return await drawUpright(
        bitmap,
        bitmap.width,
        bitmap.height,
        decoded.orientation,
        "image/jpeg",
      );
    } finally {
      bitmap.close();
    }
  }

  const { width, height } = decoded;
  const pixels = document.createElement("canvas");
  pixels.width = width;
  pixels.height = height;
  try {
    const context = pixels.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.putImageData(
      new ImageData(
        decoded.data as Uint8ClampedArray<ArrayBuffer>,
        width,
        height,
      ),
      0,
      0,
    );
    if (signal?.aborted) throw abortError();
    const type = decoded.hasAlpha ? "image/png" : "image/jpeg";
    if (decoded.orientation === 1) return await canvasBlob(pixels, type);
    return await drawUpright(pixels, width, height, decoded.orientation, type);
  } finally {
    pixels.width = pixels.height = 0;
  }
}
