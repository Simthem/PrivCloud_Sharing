/**
 * FILE_META_V1: file names and folder paths encrypted with K_share.
 *
 * Only SHARE_DEK_V1 shares use it. Before upload, the browser encrypts
 * `{ name, relativePath }` with the share key and sends the server a fixed
 * placeholder name instead. Recipients and the owner open the names with the
 * same key they already use for the file bytes.
 *
 * Format: base64url [IV 12][AES-256-GCM(JSON padded with spaces) + tag 16].
 * The share id and the file id are authenticated, so the server can neither
 * swap two names nor move a name to another share. The padding hides the
 * exact name length, in steps of 64 bytes.
 */

import {
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  decryptFile,
  encryptFile,
  importKeyFromBase64,
} from "./crypto.util";

export const FILE_META_V1 = 1;

const PADDING_BYTES = 64;
// Keeps the encoded value below 6 KB, so that it fits in one request header.
const MAX_PLAINTEXT_BYTES = 4096;

// Same rules as the server applies to names it can read (file-path.util.ts).
const MAX_FILE_NAME_LENGTH = 255;
const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_RELATIVE_PATH_SEGMENTS = 64;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const FORBIDDEN_SEGMENT = /[/\\]|\.{2}|\x00/;

export type FileMetadata = { name: string; relativePath?: string };

export class InvalidFileMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFileMetadataError";
  }
}

export function isFileMetaShare(share: {
  fileMetadataScheme?: number | null;
}): boolean {
  return share.fileMetadataScheme === FILE_META_V1;
}

function isSafeSegment(segment: string): boolean {
  return (
    !!segment &&
    segment !== "." &&
    !/^[A-Za-z]:$/.test(segment) &&
    segment.length <= MAX_FILE_NAME_LENGTH &&
    !FORBIDDEN_SEGMENT.test(segment) &&
    !CONTROL_CHARS.test(segment)
  );
}

/**
 * Validate a name and its optional folder path, and return the path the
 * server would have stored: undefined for a file at the root.
 */
export function normalizeFileMetadata(
  name: string,
  relativePath?: string | null,
): FileMetadata {
  if (!name || name.length > MAX_FILE_NAME_LENGTH || !isSafeSegment(name)) {
    throw new InvalidFileMetadataError("Invalid file name");
  }
  if (
    relativePath === undefined ||
    relativePath === null ||
    relativePath === ""
  ) {
    return { name };
  }
  if (
    relativePath.length > MAX_RELATIVE_PATH_LENGTH ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\x00")
  ) {
    throw new InvalidFileMetadataError("Invalid file path");
  }
  const segments = relativePath.split("/");
  if (
    segments.length > MAX_RELATIVE_PATH_SEGMENTS ||
    !segments.every(isSafeSegment)
  ) {
    throw new InvalidFileMetadataError("Invalid file path");
  }
  if (segments[segments.length - 1] !== name) {
    throw new InvalidFileMetadataError("File path does not match file name");
  }
  return segments.length > 1 ? { name, relativePath } : { name };
}

function additionalData(
  shareId: string,
  fileId: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `privcloud:file-meta:v1:${shareId}:${fileId}`,
  );
}

function serialize(metadata: FileMetadata): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: FILE_META_V1,
      n: metadata.name,
      ...(metadata.relativePath && { p: metadata.relativePath }),
    }),
  );
}

export async function encryptFileMetadata(
  key: CryptoKey,
  shareId: string,
  fileId: string,
  name: string,
  relativePath?: string | null,
): Promise<string> {
  let metadata = normalizeFileMetadata(name, relativePath);
  let json = serialize(metadata);
  if (json.byteLength > MAX_PLAINTEXT_BYTES) {
    // Only a folder path of several thousand bytes gets here: the file keeps
    // its name and lands at the root of the share.
    console.warn("[E2E] Folder path too long to encrypt, file kept at root");
    metadata = { name: metadata.name };
    json = serialize(metadata);
  }
  const padded = new Uint8Array(
    Math.max(
      PADDING_BYTES,
      Math.ceil(json.byteLength / PADDING_BYTES) * PADDING_BYTES,
    ),
  ).fill(0x20);
  padded.set(json);
  const encrypted = await encryptFile(
    padded.buffer,
    key,
    additionalData(shareId, fileId),
  );
  return arrayBufferToBase64Url(encrypted);
}

export async function decryptFileMetadata(
  key: CryptoKey,
  shareId: string,
  fileId: string,
  encryptedMetadata: string,
): Promise<FileMetadata> {
  const plaintext = await decryptFile(
    base64UrlToArrayBuffer(encryptedMetadata),
    key,
    additionalData(shareId, fileId),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
    v?: unknown;
    n?: unknown;
    p?: unknown;
  };
  if (
    parsed.v !== FILE_META_V1 ||
    typeof parsed.n !== "string" ||
    (parsed.p !== undefined && typeof parsed.p !== "string")
  ) {
    throw new InvalidFileMetadataError("Unsupported file metadata");
  }
  // The names end up in downloads and ZIP entries: never trust them more
  // than the server trusted plain names.
  return normalizeFileMetadata(parsed.n, parsed.p as string | undefined);
}

/**
 * Name the server stores and shows for an encrypted file. It is unique per
 * file, so that a client without FILE_META_V1 still saves every file, and it
 * is also shown for a file whose encrypted name cannot be opened.
 */
export function encryptedFilePlaceholderName(fileId: string): string {
  return `encrypted-file-${fileId.slice(0, 8)}`;
}

type EncryptedFileRow = {
  id: string;
  name: string;
  relativePath?: string | null;
  metadataScheme?: number | null;
  encryptedMetadata?: string | null;
  metadataUnreadable?: boolean;
};

/**
 * Replace the placeholder of every encrypted file with its real name and
 * folder path. Plain files are returned unchanged. A file that cannot be
 * opened keeps a neutral name and is flagged, never dropped.
 */
export async function decryptShareFileNames<T extends EncryptedFileRow>(
  shareId: string,
  files: T[],
  key: CryptoKey | string,
): Promise<T[]> {
  if (!files.some((file) => file.metadataScheme != null)) return files;
  const cryptoKey =
    typeof key === "string" ? await importKeyFromBase64(key) : key;
  const decrypted = await Promise.all(
    files.map(async (file) => {
      if (file.metadataScheme == null) return file;
      try {
        if (file.metadataScheme !== FILE_META_V1 || !file.encryptedMetadata) {
          throw new InvalidFileMetadataError("Unsupported file metadata");
        }
        const metadata = await decryptFileMetadata(
          cryptoKey,
          shareId,
          file.id,
          file.encryptedMetadata,
        );
        return {
          ...file,
          name: metadata.name,
          relativePath: metadata.relativePath ?? null,
        };
      } catch {
        return {
          ...file,
          name: encryptedFilePlaceholderName(file.id),
          relativePath: null,
          metadataUnreadable: true,
        };
      }
    }),
  );
  // The server could only sort the placeholders.
  return decrypted.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
