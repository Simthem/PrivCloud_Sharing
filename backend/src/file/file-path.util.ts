import { BadRequestException } from "@nestjs/common";

const MAX_FILE_NAME_LENGTH = 255;
const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_RELATIVE_PATH_SEGMENTS = 64;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const FORBIDDEN_SEGMENT = /[\/\\]|\.{2}|\x00/;

type ArchiveFile = {
  name: string;
  relativePath?: string | null;
};

export function assertSafeFileName(name: string): string {
  if (
    !name ||
    name.length > MAX_FILE_NAME_LENGTH ||
    FORBIDDEN_SEGMENT.test(name) ||
    CONTROL_CHARS.test(name)
  ) {
    throw new BadRequestException("Invalid file name");
  }

  return name;
}

function assertSafePathSegment(segment: string): string {
  if (
    !segment ||
    segment === "." ||
    /^[A-Za-z]:$/.test(segment) ||
    segment.length > MAX_FILE_NAME_LENGTH ||
    FORBIDDEN_SEGMENT.test(segment) ||
    CONTROL_CHARS.test(segment)
  ) {
    throw new BadRequestException("Invalid file path");
  }

  return segment;
}

export function normalizeUploadRelativePath(
  relativePath: string | undefined | null,
  fileName: string,
): string | undefined {
  assertSafeFileName(fileName);

  if (relativePath === undefined || relativePath === null || relativePath === "") {
    return undefined;
  }

  if (
    relativePath.length > MAX_RELATIVE_PATH_LENGTH ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    relativePath.includes("\\") ||
    relativePath.includes("\x00")
  ) {
    throw new BadRequestException("Invalid file path");
  }

  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.length > MAX_RELATIVE_PATH_SEGMENTS ||
    segments.some((segment) => segment === "")
  ) {
    throw new BadRequestException("Invalid file path");
  }

  const normalizedSegments = segments.map(assertSafePathSegment);
  if (normalizedSegments[normalizedSegments.length - 1] !== fileName) {
    throw new BadRequestException("File path does not match file name");
  }

  return normalizedSegments.length > 1
    ? normalizedSegments.join("/")
    : undefined;
}

export function getArchiveEntryName(file: ArchiveFile): string {
  return (
    normalizeUploadRelativePath(file.relativePath, file.name) ??
    assertSafeFileName(file.name)
  );
}
