import mime from "mime-types";
import { resolveCodeLanguage } from "./codePreview.util";
import {
  DECODED_IMAGE_MAX_SOURCE_BYTES,
  imageDecoderFormat,
  isPreviewableImageMimeType,
  RAW_IMAGE_EXTENSIONS,
} from "./imageFormats.util";
import { isLegacySpreadsheetMimeType } from "./legacySpreadsheetPreview.util";

export const E2E_BLOB_PREVIEW_MAX_SIZE = 200 * 1024 * 1024;

const NEVER_PREVIEW_EXTENSIONS = new Set([
  ".qcow",
  ".qcow2",
  ".vmdk",
  ".vdi",
  ".vhd",
  ".vhdx",
  ".ova",
  ".ovf",
  ".iso",
  ".img",
  ".raw",
  ".dmg",
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".zst",
  ".tgz",
  ".tbz2",
  ".txz",
  ".exe",
  ".dll",
  ".so",
  ".bin",
  ".deb",
  ".rpm",
  ".apk",
  ".msi",
]);

const TEXT_SAFE_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/manifest+json",
  "application/schema+json",
  "application/vnd.api+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-python",
  "application/x-perl",
  "application/x-ruby",
  "application/x-php",
  "application/x-httpd-php",
  "application/sql",
  "application/graphql",
  "application/toml",
  "application/x-toml",
  "application/yaml",
  "application/x-yaml",
  "application/x-latex",
  "application/x-tex",
  "application/x-csh",
]);

const EXTENSION_MIME_FALLBACK: Record<string, string> = {
  ...RAW_IMAGE_EXTENSIONS,
  ".log": "text/plain",
  ".out": "text/plain",
  ".err": "text/plain",
  ".txt": "text/plain",
  ".text": "text/plain",
  ".rst": "text/plain",
  ".rstx": "text/plain",
  ".lock": "text/plain",
  ".gitignore": "text/plain",
  ".dockerignore": "text/plain",
  ".editorconfig": "text/plain",
  ".npmrc": "text/plain",
  ".yarnrc": "text/plain",
  ".pem": "text/plain",
  ".pub": "text/plain",
  ".asc": "text/plain",
  ".key": "text/plain",
  ".eml": "text/plain",
  ".ics": "text/plain",
  ".srt": "text/plain",
  ".vtt": "text/plain",
  ".service": "text/plain",
  ".socket": "text/plain",
  ".desktop": "text/plain",
  ".tf": "text/plain",
  ".tfvars": "text/plain",
  ".hcl": "text/plain",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".conf": "text/plain",
  ".patch": "text/x-diff",
  ".xls": "application/vnd.ms-excel",
  ".xlt": "application/vnd.ms-excel",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  ".slk": "application/x-sylk",
  ".sylk": "application/x-sylk",
  ".dif": "application/x-dif",
  ".wk1": "application/x-lotus-123",
  ".wk3": "application/x-lotus-123",
  ".wk4": "application/x-lotus-123",
  ".wks": "application/x-lotus-123",
  ".dbf": "application/x-dbf",
  ".zig": "text/x-zig",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ott": "application/vnd.oasis.opendocument.text-template",
  ".ots": "application/vnd.oasis.opendocument.spreadsheet-template",
  ".otp": "application/vnd.oasis.opendocument.presentation-template",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".fodt": "application/vnd.oasis.opendocument.text-flat-xml",
  ".fods": "application/vnd.oasis.opendocument.spreadsheet-flat-xml",
  ".fodp": "application/vnd.oasis.opendocument.presentation-flat-xml",
};

const TECHNICAL_TEXT_NAMES: Record<string, string> = {
  makefile: "text/x-makefile",
  gnumakefile: "text/x-makefile",
  bsdmakefile: "text/x-makefile",
  dockerfile: "text/x-dockerfile",
  jenkinsfile: "text/plain",
  vagrantfile: "text/x-ruby",
  procfile: "text/plain",
  gemfile: "text/x-ruby",
  rakefile: "text/x-ruby",
  license: "text/plain",
  copying: "text/plain",
  readme: "text/plain",
  changelog: "text/plain",
};

export const isTextBasedMimeType = (mimeType: string): boolean => {
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_SAFE_APPLICATION_TYPES.has(mimeType)) return true;
  return /^application\/.*\+(json|xml|yaml)$/.test(mimeType);
};

export const resolveFileMimeType = (fileName: string): string => {
  const baseName = fileName.split(/[\\/]/).pop()?.toLowerCase() || "";
  const technicalType =
    TECHNICAL_TEXT_NAMES[baseName] ||
    (baseName.startsWith("dockerfile.") ? "text/x-dockerfile" : "");
  const codeLanguage = resolveCodeLanguage(baseName);
  if (codeLanguage && !baseName.endsWith(".svg")) {
    const codeMime: Record<string, string> = {
      javascript: "application/javascript",
      typescript: "application/typescript",
      json: "application/json",
      xml: "text/xml",
    };
    return codeMime[codeLanguage] || `text/x-${codeLanguage}`;
  }
  if (technicalType) return technicalType;
  if (
    [
      ".env",
      ".gitignore",
      ".dockerignore",
      ".editorconfig",
      ".npmrc",
      ".yarnrc",
    ].includes(baseName)
  )
    return "text/plain";

  const ext = fileName.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1];
  let mimeType =
    (ext && EXTENSION_MIME_FALLBACK[ext]) ||
    (mime.contentType(fileName) || "").split(";")[0];
  if (!mimeType) {
    const ext = fileName.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1];
    if (ext) mimeType = EXTENSION_MIME_FALLBACK[ext] || "";
  }
  return mimeType;
};

const startsWithBytes = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length &&
  signature.every((value, index) => bytes[index] === value);

const hasAsciiAt = (
  bytes: Uint8Array,
  offset: number,
  value: string,
): boolean => {
  if (bytes.length < offset + value.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
};

const isLikelyUtf8Text = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0) return true;

  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  let controlCharacters = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controlCharacters++;
    }
  }
  if (controlCharacters / sample.length > 0.01) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
};

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);

/** Major and compatible brands of an ISO media file (MP4, HEIF, AVIF, CR3). */
const isoMediaMimeType = (bytes: Uint8Array): string => {
  const size =
    bytes.length >= 4
      ? ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
      : 0;
  const end = Math.min(bytes.length, Math.max(16, size));
  const brands = new Set<string>();
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (offset === 12) continue; // minor version
    brands.add(String.fromCharCode(...bytes.subarray(offset, offset + 4)));
  }
  if (brands.has("crx ")) return RAW_IMAGE_EXTENSIONS[".cr3"];
  if (brands.has("avif") || brands.has("avis")) return "image/avif";
  if ([...brands].some((brand) => HEIF_BRANDS.has(brand))) return "image/heic";
  if (brands.has("mif1") || brands.has("msf1")) return "image/heif";
  return "video/mp4";
};

/** Detect previewable formats from a decrypted byte prefix. */
export const sniffPreviewMimeType = (bytes: Uint8Array): string | null => {
  if (hasAsciiAt(bytes, 0, "PK\x03\x04") && hasAsciiAt(bytes, 30, "mimetype")) {
    const value = new TextDecoder()
      .decode(bytes.subarray(38, 128))
      .match(/^application\/vnd\.oasis\.opendocument\.[a-z-]+/)?.[0];
    if (value && isOfficePreviewMimeType(value)) return value;
  }
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  if (
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAsciiAt(bytes, 0, "GIF87a") || hasAsciiAt(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  if (hasAsciiAt(bytes, 0, "RIFF") && hasAsciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithBytes(bytes, [0x42, 0x4d])) return "image/bmp";
  if (hasAsciiAt(bytes, 0, "RIFF") && hasAsciiAt(bytes, 8, "WAVE")) {
    return "audio/wav";
  }
  if (hasAsciiAt(bytes, 0, "OggS")) return "audio/ogg";
  if (hasAsciiAt(bytes, 0, "ID3")) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  if (hasAsciiAt(bytes, 4, "ftyp")) return isoMediaMimeType(bytes);
  if (hasAsciiAt(bytes, 0, "II*\0") || hasAsciiAt(bytes, 0, "MM\0*")) {
    return "image/tiff";
  }
  if (hasAsciiAt(bytes, 0, "IIRO") || hasAsciiAt(bytes, 0, "IIRS")) {
    return RAW_IMAGE_EXTENSIONS[".orf"];
  }
  if (hasAsciiAt(bytes, 0, "IIU\0")) return RAW_IMAGE_EXTENSIONS[".rw2"];
  if (hasAsciiAt(bytes, 0, "FUJIFILMCCD-RAW")) {
    return RAW_IMAGE_EXTENSIONS[".raf"];
  }
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return "video/webm";
  }
  if (isLikelyUtf8Text(bytes)) return "text/plain";
  return null;
};

type PreviewOptions = {
  fileSizeBytes?: number;
  isE2EEncrypted?: boolean;
};

export const isPreviewMimeTypeSupported = (
  mimeType: string,
  options?: PreviewOptions,
): boolean => {
  const isImage = isPreviewableImageMimeType(mimeType);
  const rawRanges = imageDecoderFormat(mimeType) === "raw";
  if (
    isImage &&
    !rawRanges &&
    options?.isE2EEncrypted &&
    options.fileSizeBytes != null &&
    options.fileSizeBytes > E2E_BLOB_PREVIEW_MAX_SIZE
  )
    return false;
  // Decoded on the device from a full copy of the file.
  if (
    imageDecoderFormat(mimeType) &&
    !rawRanges &&
    options?.fileSizeBytes != null &&
    options.fileSizeBytes > DECODED_IMAGE_MAX_SOURCE_BYTES
  )
    return false;
  return (
    isImage ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf" ||
    isTextBasedMimeType(mimeType) ||
    isOfficePreviewMimeType(mimeType)
  );
};

export const isOfficePreviewMimeType = (mimeType: string): boolean => {
  const value = mimeType.toLowerCase().split(";")[0].trim();
  return (
    isLegacySpreadsheetMimeType(value) ||
    /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)(-template|-flat-xml)?$/.test(
      value,
    ) ||
    /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.(document|template)|spreadsheetml\.(sheet|template)|presentationml\.(presentation|template|slideshow))$/.test(
      value,
    ) ||
    /^application\/vnd\.ms-(word\.(document|template)|excel\.(sheet|template)|powerpoint\.(presentation|template|slideshow))\.macroenabled\.12$/.test(
      value,
    ) ||
    [
      "application/rtf",
      "text/rtf",
      "text/csv",
      "application/csv",
      "text/tab-separated-values",
    ].includes(value)
  );
};

export const doesFileSupportPreview = (
  fileName: string,
  options?: PreviewOptions,
): boolean => {
  const extension = fileName.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1];
  if (extension && NEVER_PREVIEW_EXTENSIONS.has(extension)) return false;

  const mimeType = resolveFileMimeType(fileName);

  // Unknown names use a bounded prefix sniff, regardless of source size.
  if (!mimeType) {
    return (
      options?.fileSizeBytes != null &&
      Number.isSafeInteger(options.fileSizeBytes) &&
      options.fileSizeBytes >= 0
    );
  }
  return isPreviewMimeTypeSupported(mimeType, options);
};
