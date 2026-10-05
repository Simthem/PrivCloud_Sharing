/**
 * FILE_META_V1: file names and folder paths encrypted with the share's
 * content key.
 *
 * SHARE_DEK_V1 personal shares (K_share), Team folder uploads (K_team) and
 * uploads to an E2E reverse share (K_rs) can use it. Before upload, the
 * browser encrypts `{ name, relativePath }` with that key and sends the
 * server a fixed placeholder name instead. Readers open the names with the
 * same key they already use for the file bytes. The share title and
 * description of such a share travel encrypted the same way (share info).
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

// Spaces up to the next multiple of 64 bytes: the server only learns the
// length of the plaintext by steps of 64 bytes.
function pad(json: Uint8Array): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(
    Math.max(
      PADDING_BYTES,
      Math.ceil(json.byteLength / PADDING_BYTES) * PADDING_BYTES,
    ),
  ).fill(0x20);
  padded.set(json);
  return padded;
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
  const encrypted = await encryptFile(
    pad(json).buffer,
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

// ----- Share title and description -----------------------------------------

// Same limits as the server applies to readable titles (createShare.dto.ts).
const MAX_SHARE_NAME_LENGTH = 90;
const MAX_SHARE_DESCRIPTION_LENGTH = 512;

export type ShareInfo = { name?: string; description?: string };

function shareInfoAdditionalData(shareId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`privcloud:share-info:v1:${shareId}`);
}

/**
 * Encrypt the title and description of a FILE_META_V1 share with its content
 * key. Returns undefined when there is nothing to hide, so that the share
 * simply has neither.
 */
export async function encryptShareInfo(
  key: CryptoKey,
  shareId: string,
  info: ShareInfo,
): Promise<string | undefined> {
  const name = info.name || undefined;
  const description = info.description || undefined;
  if (!name && !description) return undefined;
  if (
    (name && name.length > MAX_SHARE_NAME_LENGTH) ||
    (description && description.length > MAX_SHARE_DESCRIPTION_LENGTH)
  ) {
    throw new InvalidFileMetadataError("Share title or description too long");
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      v: FILE_META_V1,
      ...(name && { n: name }),
      ...(description && { d: description }),
    }),
  );
  const encrypted = await encryptFile(
    pad(json).buffer,
    key,
    shareInfoAdditionalData(shareId),
  );
  return arrayBufferToBase64Url(encrypted);
}

export async function decryptShareInfo(
  key: CryptoKey,
  shareId: string,
  encryptedInfo: string,
): Promise<ShareInfo> {
  const plaintext = await decryptFile(
    base64UrlToArrayBuffer(encryptedInfo),
    key,
    shareInfoAdditionalData(shareId),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
    v?: unknown;
    n?: unknown;
    d?: unknown;
  };
  if (
    parsed.v !== FILE_META_V1 ||
    (parsed.n !== undefined && typeof parsed.n !== "string") ||
    (parsed.d !== undefined && typeof parsed.d !== "string")
  ) {
    throw new InvalidFileMetadataError("Unsupported share info");
  }
  const name = (parsed.n as string | undefined)?.slice(
    0,
    MAX_SHARE_NAME_LENGTH,
  );
  const description = (parsed.d as string | undefined)?.slice(
    0,
    MAX_SHARE_DESCRIPTION_LENGTH,
  );
  return {
    ...(name && !CONTROL_CHARS.test(name) && { name }),
    ...(description && { description }),
  };
}

/**
 * Title and description of a share as the reader should see them: the
 * readable columns, or the encrypted ones opened with the share key. A title
 * that cannot be opened is reported as such, never replaced by guesswork.
 */
export async function openShareInfo(
  share: {
    id: string;
    name?: string | null;
    description?: string | null;
    encryptedInfo?: string | null;
  },
  key: CryptoKey | string | null | undefined,
): Promise<ShareInfo & { infoUnreadable?: boolean }> {
  if (!share.encryptedInfo) {
    return {
      ...(share.name && { name: share.name }),
      ...(share.description && { description: share.description }),
    };
  }
  if (!key) return { infoUnreadable: true };
  try {
    const cryptoKey =
      typeof key === "string" ? await importKeyFromBase64(key) : key;
    return await decryptShareInfo(cryptoKey, share.id, share.encryptedInfo);
  } catch {
    return { infoUnreadable: true };
  }
}

type EncryptedShareRow<F extends EncryptedFileRow> = {
  id: string;
  name?: string | null;
  description?: string | null;
  encryptedInfo?: string | null;
  files: F[];
};

/**
 * Shares of a Team folder (or any list of shares under one key) with their
 * file names, titles and descriptions opened. Readable shares are returned
 * unchanged, so the result can replace the server data as it is.
 */
export async function openSharesWithKey<
  F extends EncryptedFileRow,
  S extends EncryptedShareRow<F>,
>(shares: S[], key: CryptoKey | string): Promise<S[]> {
  if (
    !shares.some(
      (share) =>
        !!share.encryptedInfo ||
        share.files.some((file) => file.metadataScheme != null),
    )
  ) {
    return shares;
  }
  const cryptoKey =
    typeof key === "string" ? await importKeyFromBase64(key) : key;
  return Promise.all(
    shares.map(async (share) => {
      const files = await decryptShareFileNames(
        share.id,
        share.files,
        cryptoKey,
      );
      if (!share.encryptedInfo) return { ...share, files };
      const info = await openShareInfo(share, cryptoKey);
      return {
        ...share,
        files,
        name: info.name ?? null,
        description: info.description ?? null,
      };
    }),
  );
}

/**
 * Real name of one file row carrying its share id, for lists that are not
 * grouped by share (access rules, search results). Unreadable names keep the
 * placeholder.
 */
export async function openFileName(
  file: {
    shareId: string;
    fileId: string;
    name: string;
    metadataScheme?: number | null;
    encryptedMetadata?: string | null;
  },
  key: CryptoKey,
): Promise<FileMetadata> {
  if (file.metadataScheme == null) return { name: file.name };
  try {
    if (file.metadataScheme !== FILE_META_V1 || !file.encryptedMetadata) {
      throw new InvalidFileMetadataError("Unsupported file metadata");
    }
    return await decryptFileMetadata(
      key,
      file.shareId,
      file.fileId,
      file.encryptedMetadata,
    );
  } catch {
    return { name: encryptedFilePlaceholderName(file.fileId) };
  }
}

// ----- Upload link name and file request subject ---------------------------

// Same limits as the server applies to readable values.
const MAX_REVERSE_SHARE_NAME_LENGTH = 90;
const MAX_FILE_REQUEST_SUBJECT_LENGTH = 120;
const MAX_FILE_REQUEST_NOTE_LENGTH = 2000;

async function encryptLabel(
  key: CryptoKey,
  context: string,
  fields: Record<string, string>,
): Promise<string> {
  const json = new TextEncoder().encode(
    JSON.stringify({ v: FILE_META_V1, ...fields }),
  );
  const encrypted = await encryptFile(
    pad(json).buffer,
    key,
    new TextEncoder().encode(context),
  );
  return arrayBufferToBase64Url(encrypted);
}

async function decryptLabel(
  key: CryptoKey,
  context: string,
  encrypted: string,
): Promise<Record<string, unknown>> {
  const plaintext = await decryptFile(
    base64UrlToArrayBuffer(encrypted),
    key,
    new TextEncoder().encode(context),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<
    string,
    unknown
  >;
  if (parsed.v !== FILE_META_V1) {
    throw new InvalidFileMetadataError("Unsupported encrypted label");
  }
  return parsed;
}

// K_rs belongs to one reverse share only, so the context needs no id.
const REVERSE_SHARE_NAME_CONTEXT = "privcloud:reverse-share-name:v1";

/** Name of an E2E reverse share, encrypted with its K_rs. */
export async function encryptReverseShareName(
  key: CryptoKey,
  name: string,
): Promise<string> {
  if (!name || name.length > MAX_REVERSE_SHARE_NAME_LENGTH) {
    throw new InvalidFileMetadataError("Invalid reverse share name");
  }
  return encryptLabel(key, REVERSE_SHARE_NAME_CONTEXT, { n: name });
}

/**
 * Name of a reverse share as its owner or an uploader should see it. Returns
 * undefined when it is encrypted and cannot be opened with this key.
 */
export async function openReverseShareName(
  reverseShare: { name?: string | null; encryptedName?: string | null },
  key: CryptoKey | string | null | undefined,
): Promise<string | undefined> {
  if (!reverseShare.encryptedName) return reverseShare.name || undefined;
  if (!key) return undefined;
  try {
    const cryptoKey =
      typeof key === "string" ? await importKeyFromBase64(key) : key;
    const { n } = await decryptLabel(
      cryptoKey,
      REVERSE_SHARE_NAME_CONTEXT,
      reverseShare.encryptedName,
    );
    if (typeof n !== "string" || CONTROL_CHARS.test(n)) return undefined;
    return n.slice(0, MAX_REVERSE_SHARE_NAME_LENGTH) || undefined;
  } catch {
    return undefined;
  }
}

export type FileRequestInfo = { subject: string; note?: string };

function fileRequestInfoContext(requestId: string): string {
  return `privcloud:file-request-info:v1:${requestId}`;
}

/** Subject and note of a Team file request, encrypted with K_team. */
export async function encryptFileRequestInfo(
  key: CryptoKey,
  requestId: string,
  info: FileRequestInfo,
): Promise<string> {
  if (
    !info.subject ||
    info.subject.length > MAX_FILE_REQUEST_SUBJECT_LENGTH ||
    (info.note && info.note.length > MAX_FILE_REQUEST_NOTE_LENGTH)
  ) {
    throw new InvalidFileMetadataError("Invalid file request subject or note");
  }
  return encryptLabel(key, fileRequestInfoContext(requestId), {
    s: info.subject,
    ...(info.note && { d: info.note }),
  });
}

/**
 * Subject and note of a file request as a member should see them. Returns
 * undefined when they are encrypted and cannot be opened with this key.
 */
export async function openFileRequestInfo(
  request: {
    id: string;
    subject: string;
    note?: string | null;
    encryptedInfo?: string | null;
  },
  key: CryptoKey | string | null | undefined,
): Promise<FileRequestInfo | undefined> {
  if (!request.encryptedInfo) {
    return {
      subject: request.subject,
      ...(request.note && { note: request.note }),
    };
  }
  if (!key) return undefined;
  try {
    const cryptoKey =
      typeof key === "string" ? await importKeyFromBase64(key) : key;
    const { s, d } = await decryptLabel(
      cryptoKey,
      fileRequestInfoContext(request.id),
      request.encryptedInfo,
    );
    if (typeof s !== "string" || CONTROL_CHARS.test(s)) return undefined;
    return {
      subject: s.slice(0, MAX_FILE_REQUEST_SUBJECT_LENGTH),
      ...(typeof d === "string" &&
        d && { note: d.slice(0, MAX_FILE_REQUEST_NOTE_LENGTH) }),
    };
  } catch {
    return undefined;
  }
}
