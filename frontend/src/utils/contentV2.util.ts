import {
  isContentV2ShareId,
  isContentV2FileId,
} from "./shareContentContext.util";
/**
 * E2EE content format v2, specified in docs/E2EE_CONTENT_V2.md.
 *
 * [header 32][record 0]...[record n-1], each record [IV 12][ciphertext + tag 16]
 * under a key derived for one file. The additional data binds every record to
 * the header, the file identity, its index and whether it is the last one.
 */

export const CONTENT_V2_MAGIC = Uint8Array.of(
  0x89,
  0x50,
  0x43,
  0x45,
  0x32,
  0x0d,
  0x0a,
  0x1a,
);
export const CONTENT_V2_VERSION = 2;
export const CONTENT_V2_HEADER_LENGTH = 32;
export const CONTENT_V2_RECORD_SIZE = 1_000_000;
export const CONTENT_V2_OVERHEAD = 28;
/** Header and the single final record of an empty file. */
export const CONTENT_V2_MIN_LENGTH =
  CONTENT_V2_HEADER_LENGTH + CONTENT_V2_OVERHEAD;

const IV_LENGTH = 12;
const NONCE_OFFSET = 14;
const NONCE_LENGTH = 16;
const ENCRYPTED_RECORD = CONTENT_V2_RECORD_SIZE + CONTENT_V2_OVERHEAD;
const PIPELINE_DEPTH = 3;
const KEY_LABEL = "privcloud:content:v2:key";
const RECORD_LABEL = "privcloud:content:v2:record";
const SHARE_FILE_KIND = "share-file";
const SIGNING_DOCUMENT_KIND = "signing-document";

/**
 * The object the content belongs to, known by the reader before any byte: a
 * share file by its identifier, or the signed result of a signing document.
 * A file identifier is created once by the client and is unique across
 * shares. The share identifier is left out on purpose: it is the capability
 * of the share link, which readers such as signers must not receive.
 */
export type ContentContext =
  | { fileId: string; shareId?: string }
  | { signingDocumentId: string };

/** Content that is not exactly what the writer produced for this file. */
export class ContentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentIntegrityError";
  }
}

const encoder = new TextEncoder();

function field(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.length > 0xffff) throw new Error("Content context too long");
  const out = new Uint8Array(2 + bytes.length);
  new DataView(out.buffer).setUint16(0, bytes.length);
  out.set(bytes, 2);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function identity(context: ContentContext): Uint8Array {
  if (context && "signingDocumentId" in context) {
    if (!context.signingDocumentId) {
      throw new Error("Content context requires a signing document");
    }
    return concat([
      field(SIGNING_DOCUMENT_KIND),
      field(context.signingDocumentId),
    ]);
  }
  if (!context?.fileId) {
    throw new Error("Content context requires a file");
  }
  return concat([field(SHARE_FILE_KIND), field(context.fileId)]);
}

/** True when the bytes start like v2 content, before any validation. */
export function isContentV2(prefix: Uint8Array): boolean {
  if (prefix.length < CONTENT_V2_MAGIC.length) return false;
  return CONTENT_V2_MAGIC.every((byte, index) => prefix[index] === byte);
}

function buildHeader(nonce: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(CONTENT_V2_HEADER_LENGTH);
  header.set(CONTENT_V2_MAGIC);
  header[8] = CONTENT_V2_VERSION;
  new DataView(header.buffer).setUint32(10, CONTENT_V2_RECORD_SIZE);
  header.set(nonce, NONCE_OFFSET);
  return header;
}

/** Every header byte is fixed except the nonce, so nothing else is accepted. */
function checkHeader(header: Uint8Array): Uint8Array<ArrayBuffer> {
  if (header.length !== CONTENT_V2_HEADER_LENGTH || !isContentV2(header)) {
    throw new ContentIntegrityError("Invalid v2 content header");
  }
  const expected = buildHeader(
    header.subarray(NONCE_OFFSET, NONCE_OFFSET + NONCE_LENGTH),
  );
  if (!expected.every((byte, index) => header[index] === byte)) {
    throw new ContentIntegrityError("Unsupported v2 content parameters");
  }
  return expected;
}

type Layout = { last: number; plainSize: number; total: number };

/**
 * Record count from the stored length. A wrong length cannot pass: the record
 * it designates as last was not encrypted as last.
 */
function layoutOf(total: number): Layout {
  if (!Number.isSafeInteger(total) || total < CONTENT_V2_MIN_LENGTH) {
    throw new ContentIntegrityError("Truncated v2 content");
  }
  const body = total - CONTENT_V2_HEADER_LENGTH;
  const count = Math.ceil(body / ENCRYPTED_RECORD);
  const tail = body - (count - 1) * ENCRYPTED_RECORD;
  if (count > 1 && tail <= CONTENT_V2_OVERHEAD) {
    throw new ContentIntegrityError("Truncated v2 content");
  }
  return {
    last: count - 1,
    plainSize: body - count * CONTENT_V2_OVERHEAD,
    total,
  };
}

/** Plaintext length of v2 content, from its stored length. */
export function contentV2PlainSize(total: number): number {
  return layoutOf(total).plainSize;
}

function recordAad(
  header: Uint8Array,
  who: Uint8Array,
  index: number,
  isLast: boolean,
): Uint8Array<ArrayBuffer> {
  const position = new Uint8Array(9);
  new DataView(position.buffer).setBigUint64(0, BigInt(index));
  position[8] = isLast ? 1 : 0;
  return concat([field(RECORD_LABEL), header, who, position]);
}

async function deriveFileKey(
  key: CryptoKey,
  header: Uint8Array,
  who: Uint8Array,
  usage: KeyUsage,
): Promise<CryptoKey> {
  if (!key.extractable) {
    throw new Error("v2 content needs an extractable content key");
  }
  const raw = await crypto.subtle.exportKey("raw", key);
  const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: concat([field(KEY_LABEL), header, who]),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export type OpenedContentV2 = {
  /** Plaintext length. */
  size: number;
  recordSize: number;
  records: number;
  /** Stored byte range [start, end) of a record. */
  recordRange: (_index: number) => [number, number];
  decryptRecord: (
    _index: number,
    _stored: Uint8Array<ArrayBuffer>,
  ) => Promise<Uint8Array<ArrayBuffer>>;
};

/** Random access, as previews and resumed reads use it. */
export async function openContentV2(
  key: CryptoKey,
  context: ContentContext,
  total: number,
  headerBytes: Uint8Array,
): Promise<OpenedContentV2> {
  await assertContentAllowed(key, headerBytes, context);
  const header = checkHeader(headerBytes);
  const layout = layoutOf(total);
  const who = identity(context);
  const fileKey = await deriveFileKey(key, header, who, "decrypt");
  const recordRange = (index: number): [number, number] => {
    if (!Number.isSafeInteger(index) || index < 0 || index > layout.last) {
      throw new ContentIntegrityError("Record out of range");
    }
    const start = CONTENT_V2_HEADER_LENGTH + index * ENCRYPTED_RECORD;
    return [start, Math.min(layout.total, start + ENCRYPTED_RECORD)];
  };
  return {
    size: layout.plainSize,
    recordSize: CONTENT_V2_RECORD_SIZE,
    records: layout.last + 1,
    recordRange,
    async decryptRecord(index, stored) {
      const [start, end] = recordRange(index);
      if (stored.length !== end - start) {
        throw new ContentIntegrityError("Record length mismatch");
      }
      // WebCrypto copies its inputs: views spare two copies of every record.
      try {
        return new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: stored.subarray(0, IV_LENGTH),
              additionalData: recordAad(
                header,
                who,
                index,
                index === layout.last,
              ),
            },
            fileKey,
            stored.subarray(IV_LENGTH),
          ),
        );
      } catch {
        throw new ContentIntegrityError("v2 content failed authentication");
      }
    },
  };
}

class ByteQueue {
  private parts: Uint8Array[] = [];
  length = 0;

  push(part: Uint8Array) {
    if (!part.length) return;
    this.parts.push(part);
    this.length += part.length;
  }

  take(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const part = this.parts[0];
      const used = Math.min(part.length, count - offset);
      out.set(part.subarray(0, used), offset);
      offset += used;
      if (used === part.length) this.parts.shift();
      else this.parts[0] = part.subarray(used);
    }
    this.length -= count;
    return out;
  }
}

/**
 * Sequential read of the whole content. The stored length is fixed by the
 * caller from the first response. A stream that ends early, even on a record
 * boundary, or runs longer, is an integrity error and never a shorter file.
 */
export async function* decryptContentV2Stream(
  key: CryptoKey,
  context: ContentContext,
  total: number,
  initial: Uint8Array,
  pull: () => Promise<Uint8Array | undefined>,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const queue = new ByteQueue();
  let received = 0;
  const accept = (part: Uint8Array) => {
    received += part.length;
    if (received > total) {
      throw new ContentIntegrityError("v2 content longer than announced");
    }
    queue.push(part);
  };
  const fill = async (count: number) => {
    while (queue.length < count) {
      const next = await pull();
      if (!next) {
        throw new ContentIntegrityError("v2 content ended before its end");
      }
      accept(next);
    }
  };
  accept(initial);
  await fill(CONTENT_V2_HEADER_LENGTH);
  const content = await openContentV2(
    key,
    context,
    total,
    queue.take(CONTENT_V2_HEADER_LENGTH),
  );
  const pending: Array<Promise<Uint8Array<ArrayBuffer>>> = [];
  for (let index = 0; index < content.records; index++) {
    const [start, end] = content.recordRange(index);
    await fill(end - start);
    const decrypted = content.decryptRecord(index, queue.take(end - start));
    void decrypted.catch(() => undefined);
    pending.push(decrypted);
    if (pending.length >= PIPELINE_DEPTH) yield await pending.shift()!;
  }
  while (pending.length) yield await pending.shift()!;
  if (queue.length || (await pull())?.length) {
    throw new ContentIntegrityError("v2 content longer than announced");
  }
}

/** Whole-buffer read, for content already held in memory. */
export async function decryptContentV2(
  key: CryptoKey,
  context: ContentContext,
  encrypted: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for await (const part of decryptContentV2Stream(
    key,
    context,
    encrypted.length,
    encrypted,
    async () => undefined,
  )) {
    parts.push(part);
  }
  return concat(parts);
}

/** Number of records of a v2 object holding `size` plaintext bytes. */
export function contentV2Records(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid v2 content size");
  }
  return Math.max(1, Math.ceil(size / CONTENT_V2_RECORD_SIZE));
}

/** Stored length of a v2 object holding `size` plaintext bytes. */
export function contentV2EncryptedSize(size: number): number {
  return (
    CONTENT_V2_HEADER_LENGTH +
    size +
    contentV2Records(size) * CONTENT_V2_OVERHEAD
  );
}

export type ContentV2Writer = {
  /** The 32 bytes that start the object. */
  header: Uint8Array<ArrayBuffer>;
  /** Plaintext bytes and record count the writer was opened for. */
  size: number;
  records: number;
  /** `[IV 12][ciphertext + tag 16]` of the record at this index. */
  sealRecord: (
    _index: number,
    _plain: Uint8Array<ArrayBuffer>,
  ) => Promise<Uint8Array<ArrayBuffer>>;
};

/**
 * Writer for one v2 object whose plaintext size is known before the first
 * record. Records can be sealed in any order and in parallel, each one is
 * bound to its index and the last one to the end of the content. A writer
 * resuming an interrupted upload passes the nonce of the header it already
 * sent, so the records it adds are under the same file key.
 */
export async function openContentV2Writer(
  key: CryptoKey,
  context: ContentContext,
  size: number,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH)),
): Promise<ContentV2Writer> {
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error("Invalid v2 content nonce");
  }
  const records = contentV2Records(size);
  const header = buildHeader(nonce);
  const who = identity(context);
  const fileKey = await deriveFileKey(key, header, who, "encrypt");
  return {
    header,
    size,
    records,
    async sealRecord(index, plain) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= records) {
        throw new Error("Record out of range");
      }
      const isLast = index === records - 1;
      const expected = isLast
        ? size - index * CONTENT_V2_RECORD_SIZE
        : CONTENT_V2_RECORD_SIZE;
      if (plain.length !== expected) {
        throw new Error("Record length does not match the content size");
      }
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: recordAad(header, who, index, isLast),
          },
          fileKey,
          plain,
        ),
      );
      const out = new Uint8Array(IV_LENGTH + sealed.length);
      out.set(iv);
      out.set(sealed, IV_LENGTH);
      return out;
    },
  };
}

/** The nonce of a header, to resume a writer on the same file key. */
export function contentV2Nonce(header: Uint8Array): Uint8Array<ArrayBuffer> {
  return checkHeader(header).slice(NONCE_OFFSET, NONCE_OFFSET + NONCE_LENGTH);
}

/** Whole-buffer write, for content already held in memory. */
export async function encryptContentV2(
  key: CryptoKey,
  context: ContentContext,
  plain: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = await openContentV2Writer(key, context, plain.length);
  const bytes = new Uint8Array(plain);
  const parts: Uint8Array[] = [writer.header];
  for (let index = 0; index < writer.records; index++) {
    parts.push(
      await writer.sealRecord(
        index,
        bytes.subarray(
          index * CONTENT_V2_RECORD_SIZE,
          (index + 1) * CONTENT_V2_RECORD_SIZE,
        ),
      ),
    );
  }
  return concat(parts);
}

// ----- Content keys with a v2 floor -----------------------------------------

/**
 * A content key created once v2 is mandatory carries its floor with it:
 * `[0x02][32-byte key]` wherever the key is transported or wrapped, in the
 * link fragment, the wrapped share, Team and reverse share keys and the access
 * grants. The floor is inside what the carrier authenticates or what the
 * server never sees, so it cannot be removed without changing the key. A bare
 * 32-byte key is a key created before the floor. Builds that predate the
 * floor refuse a 33-byte key instead of using it without its floor.
 */
export const CONTENT_KEY_FLOOR_V2 = 2;
const KEY_LENGTH = 32;
const floorKeys = new WeakSet<CryptoKey>();
const signingResultKeys = new WeakSet<CryptoKey>();
const SIGNING_RESULT_POLICY_V2 = 3;

/** Marks a key whose content must be v2. The mark is never removed. */
export function setContentV2Floor(key: CryptoKey): CryptoKey {
  floorKeys.add(key);
  return key;
}

/** True when the key only accepts and only writes v2 content. */
export function hasContentV2Floor(key: CryptoKey): boolean {
  return floorKeys.has(key);
}

/** A signing capability may read a historical source while requiring v2 results. */
export function setSigningResultV2Floor(key: CryptoKey): CryptoKey {
  signingResultKeys.add(key);
  return key;
}

export function hasSigningResultV2Floor(key: CryptoKey): boolean {
  return hasContentV2Floor(key) || signingResultKeys.has(key);
}

/** Splits transported key material into the key and its floor. */
export function decodeContentKeyMaterial(material: Uint8Array): {
  raw: Uint8Array<ArrayBuffer>;
  floor: boolean;
  signingResultFloor?: true;
} {
  if (material.length === KEY_LENGTH + 1) {
    if (material[0] === SIGNING_RESULT_POLICY_V2) {
      return { raw: material.slice(1), floor: false, signingResultFloor: true };
    }
    if (material[0] !== CONTENT_KEY_FLOOR_V2) {
      throw new Error("Unsupported content key version");
    }
    return { raw: material.slice(1), floor: true };
  }
  return { raw: material.slice(), floor: false };
}

/** Transported form of a key, with its floor when it has one. */
export function encodeContentKeyMaterial(
  raw: Uint8Array,
  floor: boolean,
  signingResultFloor = false,
): Uint8Array<ArrayBuffer> {
  if (!floor && !signingResultFloor) return raw.slice();
  if (raw.length !== KEY_LENGTH) {
    throw new Error("A v2 floor needs a 256-bit key");
  }
  const out = new Uint8Array(KEY_LENGTH + 1);
  out[0] = floor ? CONTENT_KEY_FLOOR_V2 : SIGNING_RESULT_POLICY_V2;
  out.set(raw, 1);
  return out;
}

/**
 * Format of a new write. A key with a floor always writes v2, whatever the
 * server announces. Without a floor, v2 follows the operator switch.
 */
export function contentWriteScheme(
  key: CryptoKey,
  v2WritesEnabled: boolean,
): 1 | 2 {
  return hasSigningResultV2Floor(key) || v2WritesEnabled ? 2 : 1;
}

const authenticatedPolicies = new Map<string, Set<string>>();
const rejectedMetadata = new Map<string, Set<string>>();
const keyFingerprints = new WeakMap<CryptoKey, Promise<string>>();

function keyFingerprint(key: CryptoKey): Promise<string> {
  let pending = keyFingerprints.get(key);
  if (!pending) {
    pending = crypto.subtle.exportKey("raw", key).then(async (raw) => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
      return Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    });
    keyFingerprints.set(key, pending);
  }
  return pending;
}

/** Remember a file policy only after its metadata authenticated successfully. */
export async function bindAuthenticatedContentPolicy(
  key: CryptoKey,
  context: ContentContext,
  requireV2 = true,
): Promise<void> {
  const fingerprint = await keyFingerprint(key);
  const fileIdentity = Array.from(identity(context)).join(",");
  rejectedMetadata.get(fingerprint)?.delete(fileIdentity);
  if (!requireV2) return;
  let files = authenticatedPolicies.get(fingerprint);
  if (!files) {
    files = new Set();
    authenticatedPolicies.set(fingerprint, files);
  }
  files.add(Array.from(identity(context)).join(","));
}

/** Refuse bytes when the description of this file could not authenticate. */
export async function rejectContentMetadata(
  key: CryptoKey,
  context: ContentContext,
): Promise<void> {
  const fingerprint = await keyFingerprint(key);
  let files = rejectedMetadata.get(fingerprint);
  if (!files) {
    files = new Set();
    rejectedMetadata.set(fingerprint, files);
  }
  files.add(Array.from(identity(context)).join(","));
}

/** A key floor or an authenticated file policy can require v2. */
export async function assertContentAllowed(
  key: CryptoKey,
  prefix: Uint8Array,
  context?: ContentContext,
): Promise<void> {
  if (hasSigningResultV2Floor(key) && !hasContentV2Floor(key) && !context) {
    throw new ContentIntegrityError(
      "A signing capability requires a content context",
    );
  }
  if (
    context &&
    rejectedMetadata.size &&
    rejectedMetadata
      .get(await keyFingerprint(key))
      ?.has(Array.from(identity(context)).join(","))
  ) {
    throw new ContentIntegrityError("File metadata failed authentication");
  }
  let required =
    !!(
      context &&
      "signingDocumentId" in context &&
      (hasSigningResultV2Floor(key) ||
        isContentV2FileId(context.signingDocumentId))
    ) ||
    !!(context && "fileId" in context && isContentV2FileId(context.fileId)) ||
    hasContentV2Floor(key) ||
    !!(
      context &&
      "shareId" in context &&
      context.shareId &&
      isContentV2ShareId(context.shareId)
    );
  if (!required && context && authenticatedPolicies.size) {
    required =
      authenticatedPolicies
        .get(await keyFingerprint(key))
        ?.has(Array.from(identity(context)).join(",")) ?? false;
  }
  if (required && !isContentV2(prefix)) {
    throw new ContentIntegrityError("This context only accepts v2 content");
  }
}
