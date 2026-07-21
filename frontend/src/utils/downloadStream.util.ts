export const DOWNLOAD_DISK_BATCH_SIZE = 32 * 1024 * 1024;
export const DOWNLOAD_PROGRESS_INTERVAL_MS = 250;
export const MAX_IN_MEMORY_DOWNLOAD_SIZE = 512 * 1024 * 1024;

type ProgressCallback = (
  _downloadedBytes: number,
  _totalBytes: number,
) => void;

const defaultNow = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Coalesce high-frequency network chunks into UI-friendly progress updates. */
export const createDownloadProgressReporter = (
  callback: ProgressCallback | undefined,
  totalBytes: number,
  intervalMs = DOWNLOAD_PROGRESS_INTERVAL_MS,
  now: () => number = defaultNow,
) => {
  let latestBytes = 0;
  let lastReportedBytes = -1;
  let lastReportedAt = now();

  const emit = (force: boolean) => {
    if (!callback || latestBytes === lastReportedBytes) return;
    const currentTime = now();
    const complete =
      totalBytes > 0 &&
      latestBytes >= totalBytes &&
      lastReportedBytes < totalBytes;
    if (!force && !complete && currentTime - lastReportedAt < intervalMs) {
      return;
    }
    lastReportedAt = currentTime;
    lastReportedBytes = latestBytes;
    callback(latestBytes, totalBytes);
  };

  return {
    update(downloadedBytes: number) {
      latestBytes = downloadedBytes;
      emit(false);
    },
    complete(downloadedBytes = latestBytes) {
      latestBytes = downloadedBytes;
      emit(true);
    },
  };
};

type DownloadWritable = {
  write(_data: Uint8Array<ArrayBuffer>): Promise<void>;
};

const yieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Write small decrypted crypto records as larger sequential disk operations.
 * This bounds memory while avoiding tens of thousands of File System Access
 * API calls that can destabilize long-running Chromium renderer processes.
 */
export const writeDownloadChunksToDisk = async (
  chunks: AsyncIterable<Uint8Array>,
  writable: DownloadWritable,
  signal?: AbortSignal,
  batchSize = DOWNLOAD_DISK_BATCH_SIZE,
): Promise<void> => {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("Invalid download disk batch size");
  }

  const batch: Uint8Array<ArrayBuffer> = new Uint8Array(batchSize);
  let batchLength = 0;
  let chunksProcessed = 0;

  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };

  for await (const chunk of chunks) {
    throwIfAborted();
    let sourceOffset = 0;

    while (sourceOffset < chunk.length) {
      const copyLength = Math.min(
        batchSize - batchLength,
        chunk.length - sourceOffset,
      );
      batch.set(
        chunk.subarray(sourceOffset, sourceOffset + copyLength),
        batchLength,
      );
      batchLength += copyLength;
      sourceOffset += copyLength;

      if (batchLength === batchSize) {
        throwIfAborted();
        await writable.write(batch);
        batchLength = 0;
      }
    }

    chunksProcessed++;
    if (chunksProcessed % 128 === 0) await yieldToBrowser();
  }

  if (batchLength > 0) {
    throwIfAborted();
    await writable.write(batch.subarray(0, batchLength));
  }
};
