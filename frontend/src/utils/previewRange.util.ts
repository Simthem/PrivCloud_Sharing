import {
  isContentV2ShareId,
  isContentV2FileId,
} from "./shareContentContext.util";
import {
  CONTENT_V2_HEADER_LENGTH,
  ContentIntegrityError,
  assertContentAllowed,
  isContentV2,
  openContentV2,
  type ContentContext,
  type OpenedContentV2,
} from "./contentV2.util";
import { decryptFile, ENCRYPTION_OVERHEAD } from "./crypto.util";
import { createPreviewReadCache } from "./previewReadCache.util";

export type PreviewByteSource = {
  size: number;
  read: (
    _start: number,
    _end: number,
    _signal?: AbortSignal,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Starts loading this range into the source's bounded cache without waiting
   * for it. Media playback calls it ahead of the position being read, so the
   * next reads find their records instead of paying a round trip each.
   * Aborting the signal drops what was not read yet.
   */
  prefetch?: (_start: number, _end: number, _signal: AbortSignal) => void;
};
type RangeFetcher = (
  _start: number,
  _end: number,
  _signal?: AbortSignal,
) => Promise<Response>;
export const PREVIEW_READ_BYTES = 1024 * 1024;
/** How far ahead of a media read the next bytes are prepared. */
export const PREVIEW_READ_AHEAD_BYTES = 8 * 1024 * 1024;

/**
 * A range must really be partial: never buffer a server's full-file fallback.
 * With allowShorter, a range past the end is accepted as clipped to the file.
 */
export async function readVerifiedRange(
  fetchRange: RangeFetcher,
  start: number,
  end: number,
  signal?: AbortSignal,
  allowShorter = false,
) {
  const response = await fetchRange(start, end, signal);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("Content-Range") || "",
  );
  const total = Number(match?.[3]);
  const last = allowShorter ? Math.min(end, total - 1) : end;
  if (
    response.status !== 206 ||
    !match ||
    Number(match[1]) !== start ||
    Number(match[2]) !== last ||
    !Number.isSafeInteger(total) ||
    total <= last
  ) {
    await response.body?.cancel();
    throw new Error("Preview requires valid byte-range responses");
  }
  const expected = last - start + 1;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing preview response body");
  const bytes = new Uint8Array(expected);
  let written = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (written + value.length > expected)
        throw new Error("Oversized preview range");
      bytes.set(value, written);
      written += value.length;
    }
    if (written !== expected) throw new Error("Incomplete preview range");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { bytes, total: Number(match[3]), headers: response.headers };
}

/** Plaintext random access over independently authenticated AES-GCM records. */
export async function createPreviewByteSource(
  fetchRange: RangeFetcher,
  key?: CryptoKey,
  legacyChunkSize: number | (() => Promise<number>) = 10_000_000,
  signal?: AbortSignal,
  context?: ContentContext,
): Promise<PreviewByteSource> {
  // An encrypted source reads the v2 header span in the same first request.
  const initial = await readVerifiedRange(
    fetchRange,
    0,
    key ? CONTENT_V2_HEADER_LENGTH - 1 : 0,
    signal,
    true,
  );
  if (
    !key &&
    context &&
    "fileId" in context &&
    (isContentV2FileId(context.fileId) ||
      !!(context.shareId && isContentV2ShareId(context.shareId)))
  ) {
    throw new ContentIntegrityError(
      "An encryption key is required for this context",
    );
  }
  const encryptedSize = initial.total;
  let recordSize = Number(initial.headers.get("X-Encryption-Chunk-Size"));
  let cachedIndex = -1;
  let cachedRecord: Uint8Array<ArrayBuffer> | null = null;
  const readStored = async (
    start: number,
    end: number,
    readSignal?: AbortSignal,
  ) => {
    const result = await readVerifiedRange(
      fetchRange,
      start,
      end - 1,
      readSignal,
    );
    if (result.total !== encryptedSize)
      throw new Error("Preview file changed during reading");
    return result.bytes;
  };
  let v2: OpenedContentV2 | null = null;
  if (key) await assertContentAllowed(key, initial.bytes, context);
  if (key && isContentV2(initial.bytes)) {
    if (!context) {
      throw new ContentIntegrityError("v2 content is not readable here");
    }
    v2 = await openContentV2(key, context, encryptedSize, initial.bytes);
    recordSize = v2.recordSize;
  }
  if (
    key &&
    !v2 &&
    !(
      Number.isSafeInteger(recordSize) &&
      recordSize >= 1_000_000 &&
      recordSize <= 200_000_000
    )
  ) {
    // Probe records before trying the historical single-block format. A legacy
    // single-block GCM file necessarily needs its entire authenticated record.
    const legacySize =
      typeof legacyChunkSize === "function"
        ? await legacyChunkSize()
        : legacyChunkSize;
    signal?.throwIfAborted();
    const candidates = [
      ...new Set([
        legacySize,
        ...Array.from({ length: 200 }, (_, i) => (i + 1) * 1_000_000),
      ]),
    ];
    let probe = new Uint8Array(0);
    recordSize = 0;
    for (const candidate of candidates
      .filter((n) => n + ENCRYPTION_OVERHEAD < encryptedSize)
      .sort((a, b) => a - b)) {
      signal?.throwIfAborted();
      const length = candidate + ENCRYPTION_OVERHEAD;
      const extra = await readStored(probe.length, length, signal);
      const grown = new Uint8Array(length);
      grown.set(probe);
      grown.set(extra, probe.length);
      probe = grown;
      try {
        cachedRecord = new Uint8Array(await decryptFile(probe.buffer, key));
        recordSize = candidate;
        cachedIndex = 0;
        break;
      } catch {
        /* Wrong legacy record boundary. */
      }
    }
    if (!recordSize) {
      if (encryptedSize > 200_000_000 + ENCRYPTION_OVERHEAD)
        throw new Error("Unrecognized legacy encryption layout");
      const extra = await readStored(probe.length, encryptedSize, signal);
      const whole = new Uint8Array(encryptedSize);
      whole.set(probe);
      whole.set(extra, probe.length);
      cachedRecord = new Uint8Array(await decryptFile(whole.buffer, key));
      recordSize = cachedRecord.length;
      cachedIndex = 0;
    }
  }
  const encryptedRecordSize = recordSize + ENCRYPTION_OVERHEAD;
  const remainder = encryptedSize % encryptedRecordSize;
  if (
    key &&
    !v2 &&
    (recordSize <= 0 || (remainder > 0 && remainder <= ENCRYPTION_OVERHEAD))
  )
    throw new Error("Invalid encrypted preview layout");
  const size = v2
    ? v2.size
    : key
      ? encryptedSize -
        Math.ceil(encryptedSize / encryptedRecordSize) * ENCRYPTION_OVERHEAD
      : encryptedSize;
  // Three independent reads hide round-trip latency without unbounded prefetch.
  // Large historical GCM records retain at most one record and load one at a time.
  const budget = Math.max(24 * 1024 * 1024, key ? recordSize : 0);
  const cache = createPreviewReadCache(
    budget,
    key ? Math.max(1, Math.min(3, Math.floor(budget / recordSize))) : 3,
    signal,
  );
  let legacyRecord = cachedRecord;
  cachedRecord = null;
  const readBlock = (
    blockSize: number,
    index: number,
    readSignal?: AbortSignal,
  ) =>
    cache.read(
      `${blockSize}:${index}`,
      async (loadSignal) => {
        if (!key)
          return readStored(
            index * blockSize,
            Math.min(size, (index + 1) * blockSize),
            loadSignal,
          );
        if (v2) {
          const [storedStart, storedEnd] = v2.recordRange(index);
          const stored = await readStored(storedStart, storedEnd, loadSignal);
          loadSignal.throwIfAborted();
          return v2.decryptRecord(index, stored);
        }
        if (index === cachedIndex && legacyRecord) {
          const first = legacyRecord;
          legacyRecord = null;
          return first;
        }
        const storedStart = index * encryptedRecordSize;
        const encrypted = await readStored(
          storedStart,
          Math.min(encryptedSize, storedStart + encryptedRecordSize),
          loadSignal,
        );
        loadSignal.throwIfAborted();
        return new Uint8Array(await decryptFile(encrypted.buffer, key));
      },
      readSignal,
    );
  // Playback windows: the block size read() picks for a MiB read.
  const playbackBlockSize = key ? recordSize : PREVIEW_READ_BYTES;
  return {
    size,
    async read(start, end, readSignal) {
      signal?.throwIfAborted();
      readSignal?.throwIfAborted();
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > size ||
        end - start > PREVIEW_READ_BYTES
      )
        throw new Error("Invalid preview read");
      // Tiny MP4 headers and PDF requests share 64 KiB windows. Playback reads
      // use MiB windows. All cached plaintext stays in this source's memory.
      const blockSize = key
        ? recordSize
        : end - start <= 128 * 1024
          ? 64 * 1024
          : PREVIEW_READ_BYTES;
      const first = Math.floor(start / blockSize);
      const last = Math.floor((end - 1) / blockSize);
      const blocks = await Promise.all(
        Array.from({ length: last - first + 1 }, (_, n) =>
          readBlock(blockSize, first + n, readSignal),
        ),
      );
      readSignal?.throwIfAborted();
      signal?.throwIfAborted();
      // Never hand the retained buffer to a transferable MessagePort or caller.
      const result = new Uint8Array(end - start);
      for (let n = 0; n < blocks.length; n++) {
        const base = (first + n) * blockSize;
        const from = Math.max(start, base);
        const to = Math.min(end, base + blocks[n].length);
        result.set(blocks[n].subarray(from - base, to - base), from - start);
      }
      return result;
    },
    prefetch(start, end, aheadSignal) {
      if (signal?.aborted || aheadSignal.aborted) return;
      const from = Math.max(0, start);
      const to = Math.min(size, end);
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        to <= from
      )
        return;
      const first = Math.floor(from / playbackBlockSize);
      // At most half the cache ahead, so the window being played is never
      // evicted by the one being prepared. Large legacy records get none.
      const last = Math.min(
        Math.floor((to - 1) / playbackBlockSize),
        first + Math.floor(budget / 2 / playbackBlockSize) - 1,
      );
      // The same authenticated loads as read(): a prefetched record reaches
      // the player only once a read asks for it, after its tag was verified.
      for (let index = first; index <= last; index++)
        readBlock(playbackBlockSize, index, aheadSignal).catch(() => undefined);
    },
  };
}

export async function readPreviewBytes(
  source: PreviewByteSource,
  start: number,
  end: number,
  signal?: AbortSignal,
) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.size ||
    end - start > 16 * 1024 * 1024
  )
    throw new Error("Preview request exceeds memory budget");
  const result = new Uint8Array(end - start);
  for (let offset = start; offset < end; offset += PREVIEW_READ_BYTES * 3) {
    signal?.throwIfAborted();
    const base = offset;
    await Promise.all(
      Array.from(
        { length: Math.min(3, Math.ceil((end - base) / PREVIEW_READ_BYTES)) },
        async (_, index) => {
          const from = base + index * PREVIEW_READ_BYTES;
          result.set(
            await source.read(
              from,
              Math.min(end, from + PREVIEW_READ_BYTES),
              signal,
            ),
            from - start,
          );
        },
      ),
    );
  }
  return result;
}
