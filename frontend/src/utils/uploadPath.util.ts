const MAX_FILE_NAME_LENGTH = 255;
const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_RELATIVE_PATH_SEGMENTS = 64;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const FORBIDDEN_SEGMENT = /[\/\\]|\.{2}|\x00/;

type FileLike = {
  name: string;
  uploadRelativePath?: string | null;
  relativePath?: string | null;
  webkitRelativePath?: string;
  path?: string;
};

type UploadPathFile = FileLike & {
  uploadRelativePath?: string;
};

const isSafeFileName = (name: string) =>
  !!name &&
  name.length <= MAX_FILE_NAME_LENGTH &&
  !FORBIDDEN_SEGMENT.test(name) &&
  !CONTROL_CHARS.test(name);

const isSafePathSegment = (segment: string) =>
  isSafeFileName(segment) &&
  segment !== "." &&
  !/^[A-Za-z]:$/.test(segment);

export function normalizeClientRelativePath(
  rawPath: string | undefined | null,
  fileName: string,
): string | undefined {
  if (!rawPath || !isSafeFileName(fileName)) return undefined;

  const pathWithoutLeadingSlash = rawPath.replace(/^\/+/, "");
  if (
    !pathWithoutLeadingSlash ||
    pathWithoutLeadingSlash.length > MAX_RELATIVE_PATH_LENGTH ||
    pathWithoutLeadingSlash.includes("\\") ||
    pathWithoutLeadingSlash.includes("\x00")
  ) {
    return undefined;
  }

  const segments = pathWithoutLeadingSlash.split("/");
  if (
    segments.length === 0 ||
    segments.length > MAX_RELATIVE_PATH_SEGMENTS ||
    segments.some((segment) => segment === "" || !isSafePathSegment(segment))
  ) {
    return undefined;
  }

  if (segments[segments.length - 1] !== fileName) return undefined;

  return segments.length > 1 ? segments.join("/") : undefined;
}

export function getUploadRelativePath(file: FileLike): string | undefined {
  return normalizeClientRelativePath(
    file.uploadRelativePath ||
      file.relativePath ||
      file.webkitRelativePath ||
      file.path,
    file.name,
  );
}

export function getFileDisplayPath(file: FileLike): string {
  return file.uploadRelativePath || file.relativePath || file.name;
}

export function getSafeZipEntryName(file: FileLike): string {
  return getUploadRelativePath(file) || file.name;
}

export function attachUploadRelativePath<T extends UploadPathFile>(
  file: T,
  rawPath?: string,
): T {
  const relativePath =
    normalizeClientRelativePath(rawPath, file.name) || getUploadRelativePath(file);

  if (!relativePath) return file;

  try {
    Object.defineProperty(file, "uploadRelativePath", {
      value: relativePath,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    try {
      file.uploadRelativePath = relativePath;
    } catch {
      return file;
    }
  }

  return file;
}
