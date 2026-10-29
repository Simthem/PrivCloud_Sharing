import { BadRequestException, ConflictException } from "@nestjs/common";

/**
 * E2EE content formats of a file, specified in docs/E2EE_CONTENT_V2.md. The
 * server stores opaque bytes: it only checks the declared layout, the fixed
 * header bytes when the first part passes through it, and which format new
 * uploads may use.
 */
export const CONTENT_V2 = 2;
export const CONTENT_V2_HEADER_BYTES = 32;
export const CONTENT_V2_RECORD_BYTES = 1_000_000;
const CONTENT_V2_MAGIC = Buffer.from([
  0x89, 0x50, 0x43, 0x45, 0x32, 0x0d, 0x0a, 0x1a,
]);

/** Absent is v1, the format of every file written before this column. */
export type ContentScheme = typeof CONTENT_V2 | undefined;

export function parseContentScheme(value: unknown): ContentScheme {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === CONTENT_V2 || value === "2") return CONTENT_V2;
  throw new BadRequestException("Invalid contentScheme parameter");
}

/** Bytes the v2 header adds to a part. Only the first part carries it. */
export function contentHeaderBytes(
  scheme: ContentScheme,
  chunkIndex: number,
): number {
  return scheme === CONTENT_V2 && chunkIndex === 0
    ? CONTENT_V2_HEADER_BYTES
    : 0;
}

/** Every header byte is fixed except the 16-byte nonce. */
export function isContentV2Header(bytes: unknown): bytes is Buffer {
  return (
    Buffer.isBuffer(bytes) &&
    bytes.length >= CONTENT_V2_HEADER_BYTES &&
    bytes.subarray(0, 8).equals(CONTENT_V2_MAGIC) &&
    bytes[8] === 2 &&
    bytes[9] === 0 &&
    bytes.readUInt32BE(10) === CONTENT_V2_RECORD_BYTES &&
    bytes[30] === 0 &&
    bytes[31] === 0
  );
}

/**
 * Format of a new upload. While v2 writes are on, a client that still writes
 * v1, such as a page loaded before the switch, an older APK or Companion, is
 * refused before anything is stored, with a code that makes a current client
 * start again in v2. v2 is always accepted: turning writes off never blocks a
 * key whose floor requires v2.
 */
export function assertUploadContentScheme(upload: {
  isE2EEncrypted: boolean;
  scheme: ContentScheme;
  v2WritesEnabled: boolean;
  encryptionChunkSize?: number;
  fileId?: string;
  shareId?: string;
}): void {
  if (!upload.isE2EEncrypted) {
    if (upload.scheme) {
      throw new BadRequestException(
        "A content scheme only applies to end-to-end encrypted shares",
      );
    }
    return;
  }
  if (upload.scheme === CONTENT_V2) {
    if (upload.encryptionChunkSize !== CONTENT_V2_RECORD_BYTES) {
      throw new BadRequestException(
        "E2EE content v2 uses 1000000-byte records",
      );
    }
    if (!upload.fileId) {
      throw new BadRequestException(
        "E2EE content v2 is bound to a file id chosen by the client",
      );
    }
    return;
  }
  const contextRequiresV2 =
    /^v2\.[A-Za-z0-9_-]{3,47}$/.test(upload.shareId ?? "") ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      upload.fileId ?? "",
    );
  if (upload.v2WritesEnabled || contextRequiresV2) {
    throw new ConflictException(
      "Update or reload PrivCloud to use the updated end-to-end encryption",
      "e2ee_content_v2_required",
    );
  }
}

/** The first part of a v2 upload starts with a well-formed header. */
export function assertContentV2FirstPart(
  scheme: ContentScheme,
  chunkIndex: number,
  body: Buffer,
): void {
  if (scheme === CONTENT_V2 && chunkIndex === 0 && !isContentV2Header(body)) {
    throw new BadRequestException("Invalid E2EE content v2 header");
  }
}

/** A current signing identity cannot store a historical encrypted result. */
export function assertSigningResultContent(
  documentId: string,
  bytes: Buffer,
): void {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      documentId,
    ) &&
    (!isContentV2Header(bytes) || bytes.length < 60)
  ) {
    throw new ConflictException(
      "Update or reload PrivCloud to finalize this encrypted document",
      "e2ee_content_v2_required",
    );
  }
}
