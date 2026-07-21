import mime from "mime-types";

export const E2E_BLOB_PREVIEW_MAX_SIZE = 200 * 1024 * 1024;
export const TEXT_PREVIEW_MAX_SOURCE_SIZE = 100 * 1024 * 1024;
export const UNKNOWN_PREVIEW_SNIFF_MAX_SIZE = 16 * 1024 * 1024;

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
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".kt": "text/x-kotlin",
  ".swift": "text/x-swift",
  ".rb": "text/x-ruby",
  ".lua": "text/x-lua",
  ".r": "text/x-r",
  ".m": "text/x-objectivec",
  ".scala": "text/x-scala",
  ".zig": "text/x-zig",
  ".toml": "text/x-toml",
  ".dockerfile": "text/x-dockerfile",
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
  if (technicalType) return technicalType;

  let mimeType = (mime.contentType(fileName) || "").split(";")[0];
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

/** Detect previewable formats from a decrypted byte prefix. */
export const sniffPreviewMimeType = (bytes: Uint8Array): string | null => {
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
  if (hasAsciiAt(bytes, 4, "ftyp")) return "video/mp4";
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
  const requiresE2EBlob =
    mimeType.startsWith("video/") ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf";
  const isTextPreview = isTextBasedMimeType(mimeType);

  if (
    isTextPreview &&
    options?.fileSizeBytes != null &&
    options.fileSizeBytes > TEXT_PREVIEW_MAX_SOURCE_SIZE
  ) {
    return false;
  }

  if (
    requiresE2EBlob &&
    options?.isE2EEncrypted &&
    options.fileSizeBytes != null &&
    options.fileSizeBytes > E2E_BLOB_PREVIEW_MAX_SIZE
  ) {
    return false;
  }

  return requiresE2EBlob || isTextPreview;
};

export const doesFileSupportPreview = (
  fileName: string,
  options?: PreviewOptions,
): boolean => {
  const extension = fileName.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1];
  if (extension && NEVER_PREVIEW_EXTENSIONS.has(extension)) return false;

  const mimeType = resolveFileMimeType(fileName);

  // Unknown names remain eligible only for a small, bounded content sniff.
  if (!mimeType) {
    return (
      options?.fileSizeBytes != null &&
      options.fileSizeBytes <= UNKNOWN_PREVIEW_SNIFF_MAX_SIZE
    );
  }
  return isPreviewMimeTypeSupported(mimeType, options);
};
