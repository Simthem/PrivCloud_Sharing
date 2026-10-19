import type { ImageDecoderFormat } from "./imageDecoderCore.util";

/** Displayed by an <img> in every supported browser and Android WebView. */
const BROWSER_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-bmp",
  "image/x-ms-bmp",
  "image/vnd.microsoft.icon",
  "image/x-icon",
  "image/svg+xml",
]);

const HEIF_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

const TIFF_MIME_TYPES = new Set(["image/tiff", "image/tiff-fx"]);

/** Camera RAW files, previewed through the JPEG the camera embeds in them. */
export const RAW_IMAGE_EXTENSIONS: Record<string, string> = {
  ".3fr": "image/x-hasselblad-3fr",
  ".arw": "image/x-sony-arw",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".crw": "image/x-canon-crw",
  ".dcr": "image/x-kodak-dcr",
  ".dng": "image/x-adobe-dng",
  ".erf": "image/x-epson-erf",
  ".fff": "image/x-hasselblad-fff",
  ".iiq": "image/x-phaseone-iiq",
  ".kdc": "image/x-kodak-kdc",
  ".mef": "image/x-mamiya-mef",
  ".mos": "image/x-leaf-mos",
  ".mrw": "image/x-minolta-mrw",
  ".nef": "image/x-nikon-nef",
  ".nrw": "image/x-nikon-nrw",
  ".orf": "image/x-olympus-orf",
  ".pef": "image/x-pentax-pef",
  ".raf": "image/x-fuji-raf",
  ".rw2": "image/x-panasonic-rw2",
  ".rwl": "image/x-leica-rwl",
  ".sr2": "image/x-sony-sr2",
  ".srf": "image/x-sony-srf",
  ".srw": "image/x-samsung-srw",
  ".x3f": "image/x-sigma-x3f",
};

const RAW_MIME_TYPES = new Set(Object.values(RAW_IMAGE_EXTENSIONS));

/**
 * Decoded images are read in full and converted on the device: past this
 * size a phone would hold several copies of a file nobody waits for.
 */
export const DECODED_IMAGE_MAX_SOURCE_BYTES = 120 * 1024 * 1024;

const normalize = (mimeType: string) =>
  mimeType.toLowerCase().split(";")[0].trim();

/** The decoder an image needs before a browser can show it, if any. */
export const imageDecoderFormat = (
  mimeType: string,
): ImageDecoderFormat | null => {
  const value = normalize(mimeType);
  if (HEIF_MIME_TYPES.has(value)) return "heif";
  if (TIFF_MIME_TYPES.has(value)) return "tiff";
  if (RAW_MIME_TYPES.has(value)) return "raw";
  return null;
};

/** Images the preview can show: natively, or after decoding on the device. */
export const isPreviewableImageMimeType = (mimeType: string): boolean =>
  BROWSER_IMAGE_MIME_TYPES.has(normalize(mimeType)) ||
  imageDecoderFormat(mimeType) !== null;

/**
 * Canvas transform that draws a width x height image upright for an Exif or
 * TIFF orientation (1-8), and the size of the upright result.
 */
export const orientationTransform = (
  orientation: number,
  width: number,
  height: number,
): {
  width: number;
  height: number;
  matrix: [number, number, number, number, number, number];
} => {
  switch (orientation) {
    case 2:
      return { width, height, matrix: [-1, 0, 0, 1, width, 0] };
    case 3:
      return { width, height, matrix: [-1, 0, 0, -1, width, height] };
    case 4:
      return { width, height, matrix: [1, 0, 0, -1, 0, height] };
    case 5:
      return { width: height, height: width, matrix: [0, 1, 1, 0, 0, 0] };
    case 6:
      return { width: height, height: width, matrix: [0, 1, -1, 0, height, 0] };
    case 7:
      return {
        width: height,
        height: width,
        matrix: [0, -1, -1, 0, height, width],
      };
    case 8:
      return { width: height, height: width, matrix: [0, -1, 1, 0, 0, width] };
    default:
      return { width, height, matrix: [1, 0, 0, 1, 0, 0] };
  }
};
