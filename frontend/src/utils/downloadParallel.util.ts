export const DEFAULT_DIRECT_DOWNLOAD_CONCURRENCY = 4;
export const DEFAULT_DIRECT_DOWNLOAD_PART_BYTES = 32 * 1024 * 1024;
export const DEFAULT_DIRECT_DOWNLOAD_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

const MIN_DIRECT_DOWNLOAD_PART_BYTES = 1024 * 1024;
const MAX_DIRECT_DOWNLOAD_PART_BYTES = 128 * 1024 * 1024;
const MIN_DIRECT_DOWNLOAD_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_DIRECT_DOWNLOAD_BUFFER_BYTES = 300_000_000;
const MAX_DIRECT_DOWNLOAD_CONCURRENCY = 32;
const DEFAULT_RANGE_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;

export type DirectDownloadRange = {
  index: number;
  start: number;
  end: number;
};

export type DirectDownloadRangeFetcher = (
  _range: DirectDownloadRange,
  _signal: AbortSignal,
) => Promise<Response>;

export type DirectDownloadParallelConfig = {
  enabled: boolean;
  concurrency: number;
  partBytes: number;
  maxBufferBytes: number;
  totalParts: number;
};

export type DirectDownloadParallelOptions = {
  totalSize: number;
  concurrency?: number;
  partBytes?: number;
  maxBufferBytes?: number;
  encryptedRecordBytes?: number | null;
  fetchRange: DirectDownloadRangeFetcher;
  signal?: AbortSignal;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

type BufferedRangeOutcome =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; error: unknown };

const clampInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
};

/**
 * Resolve every server-advertised value against hard browser safety bounds.
 *
 * When the exact E2E record size is known, ranges end on authenticated-record
 * boundaries. The final range may be shorter because the final record itself
 * can be partial.
 */
export const resolveDirectDownloadParallelConfig = ({
  totalSize,
  concurrency,
  partBytes,
  maxBufferBytes,
  encryptedRecordBytes,
}: Omit<
  DirectDownloadParallelOptions,
  | "fetchRange"
  | "signal"
  | "maxAttempts"
  | "retryBaseDelayMs"
  | "retryMaxDelayMs"
>): DirectDownloadParallelConfig => {
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new Error("Invalid direct download size");
  }

  const requestedConcurrency = clampInteger(
    concurrency,
    DEFAULT_DIRECT_DOWNLOAD_CONCURRENCY,
    1,
    MAX_DIRECT_DOWNLOAD_CONCURRENCY,
  );
  let boundedPartBytes = clampInteger(
    partBytes,
    DEFAULT_DIRECT_DOWNLOAD_PART_BYTES,
    MIN_DIRECT_DOWNLOAD_PART_BYTES,
    MAX_DIRECT_DOWNLOAD_PART_BYTES,
  );

  if (
    encryptedRecordBytes != null &&
    Number.isSafeInteger(encryptedRecordBytes) &&
    encryptedRecordBytes > 0
  ) {
    if (encryptedRecordBytes > MAX_DIRECT_DOWNLOAD_PART_BYTES) {
      return {
        enabled: false,
        concurrency: 1,
        partBytes: boundedPartBytes,
        maxBufferBytes: boundedPartBytes,
        totalParts: totalSize === 0 ? 0 : 1,
      };
    }
    const recordsPerRange = Math.max(
      Math.ceil(MIN_DIRECT_DOWNLOAD_PART_BYTES / encryptedRecordBytes),
      Math.floor(boundedPartBytes / encryptedRecordBytes),
      1,
    );
    boundedPartBytes = recordsPerRange * encryptedRecordBytes;
  }

  const requestedMaxBuffer = clampInteger(
    maxBufferBytes,
    DEFAULT_DIRECT_DOWNLOAD_MAX_BUFFER_BYTES,
    MIN_DIRECT_DOWNLOAD_BUFFER_BYTES,
    MAX_DIRECT_DOWNLOAD_BUFFER_BYTES,
  );
  const effectiveMaxBuffer = Math.max(boundedPartBytes, requestedMaxBuffer);
  const totalParts =
    totalSize === 0 ? 0 : Math.ceil(totalSize / boundedPartBytes);
  const concurrencyByMemory = Math.max(
    1,
    Math.floor(effectiveMaxBuffer / boundedPartBytes),
  );
  const effectiveConcurrency = Math.min(
    requestedConcurrency,
    concurrencyByMemory,
    Math.max(1, totalParts),
  );

  return {
    enabled: totalParts >= 2 && effectiveConcurrency >= 2,
    concurrency: effectiveConcurrency,
    partBytes: boundedPartBytes,
    maxBufferBytes: effectiveConcurrency * boundedPartBytes,
    totalParts,
  };
};

const createAbortError = (): DOMException =>
  new DOMException("Aborted", "AbortError");

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(createAbortError());
  if (delayMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
};

const parseContentRange = (
  value: string | null,
): { start: number; end: number; total: number } | null => {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total)
  ) {
    return null;
  }
  return { start, end, total };
};

const isRetriableRangeStatus = (status: number): boolean =>
  [408, 425, 429, 500, 502, 503, 504].includes(status);

class DirectDownloadRangeError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "DirectDownloadRangeError";
    this.retryable = retryable;
  }
}

const readExactRange = async (
  response: Response,
  range: DirectDownloadRange,
  totalSize: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> => {
  const expectedLength = range.end - range.start + 1;
  const parsed = parseContentRange(response.headers.get("Content-Range"));
  const advertisedLength = response.headers.get("Content-Length");
  const parsedLength =
    advertisedLength == null ? expectedLength : Number(advertisedLength);

  if (
    response.status !== 206 ||
    !parsed ||
    parsed.start !== range.start ||
    parsed.end !== range.end ||
    parsed.total !== totalSize ||
    !Number.isSafeInteger(parsedLength) ||
    parsedLength !== expectedLength ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new DirectDownloadRangeError(
      "Storage returned an invalid direct download range",
      isRetriableRangeStatus(response.status),
    );
  }

  const output = new Uint8Array(expectedLength);
  const reader = response.body.getReader();
  let written = 0;
  try {
    for (;;) {
      if (signal.aborted) throw createAbortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (written + value.length > expectedLength) {
        throw new DirectDownloadRangeError(
          "Storage range exceeded its declared length",
          false,
        );
      }
      output.set(value, written);
      written += value.length;
    }
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw createAbortError();
    }
    if (error instanceof DirectDownloadRangeError) throw error;
    throw new DirectDownloadRangeError(
      error instanceof Error ? error.message : "Direct range read failed",
      true,
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* response already closed */
    }
    try {
      reader.releaseLock();
    } catch {
      /* reader already released */
    }
  }

  if (written !== expectedLength) {
    throw new DirectDownloadRangeError(
      `Storage range ended early (${written}/${expectedLength})`,
      true,
    );
  }
  return output;
};

/**
 * Download bounded ranges concurrently and expose one strictly ordered stream.
 *
 * No range is exposed until it has been validated and read in full, therefore
 * retrying an exact range can never duplicate bytes in the consumer stream.
 * At most `concurrency * partBytes` is buffered.
 */
export const createParallelDirectDownloadBody = (
  options: DirectDownloadParallelOptions,
): {
  stream: ReadableStream<Uint8Array>;
  config: DirectDownloadParallelConfig;
} => {
  const config = resolveDirectDownloadParallelConfig(options);
  if (!config.enabled) {
    throw new Error("Parallel direct download is not applicable");
  }

  const maxAttempts = clampInteger(
    options.maxAttempts,
    DEFAULT_RANGE_ATTEMPTS,
    1,
    8,
  );
  const retryBaseDelayMs = clampInteger(
    options.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
    0,
    30_000,
  );
  const retryMaxDelayMs = clampInteger(
    options.retryMaxDelayMs,
    DEFAULT_RETRY_MAX_DELAY_MS,
    retryBaseDelayMs,
    60_000,
  );
  const downloadController = new AbortController();
  const abortFromParent = () => downloadController.abort();
  if (options.signal?.aborted) downloadController.abort();
  else
    options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const outcomes = new Map<number, Promise<BufferedRangeOutcome>>();
  let nextToLaunch = 0;
  let nextToEmit = 0;
  let settled = false;

  const cleanup = () => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", abortFromParent);
  };
  const abortAll = () => {
    downloadController.abort();
    cleanup();
  };
  const getRange = (index: number): DirectDownloadRange => {
    const start = index * config.partBytes;
    return {
      index,
      start,
      end: Math.min(options.totalSize - 1, start + config.partBytes - 1),
    };
  };
  const readRangeWithRetry = async (
    range: DirectDownloadRange,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (downloadController.signal.aborted) throw createAbortError();
      let response: Response | undefined;
      try {
        response = await options.fetchRange(range, downloadController.signal);
        return await readExactRange(
          response,
          range,
          options.totalSize,
          downloadController.signal,
        );
      } catch (error) {
        lastError = error;
        await response?.body?.cancel().catch(() => undefined);
        if (
          downloadController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          throw createAbortError();
        }
        const retryable =
          !(error instanceof DirectDownloadRangeError) || error.retryable;
        if (!retryable || attempt >= maxAttempts) break;
        const delayMs = Math.min(
          retryBaseDelayMs * Math.pow(2, attempt - 1),
          retryMaxDelayMs,
        );
        await waitForRetry(delayMs, downloadController.signal);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Direct range download failed");
  };
  const launch = (index: number) => {
    if (index >= config.totalParts || outcomes.has(index)) return;
    outcomes.set(
      index,
      readRangeWithRetry(getRange(index)).then(
        (bytes): BufferedRangeOutcome => ({ ok: true, bytes }),
        (error): BufferedRangeOutcome => ({ ok: false, error }),
      ),
    );
    nextToLaunch = Math.max(nextToLaunch, index + 1);
  };
  const fillWindow = () => {
    while (
      nextToLaunch < config.totalParts &&
      nextToLaunch - nextToEmit < config.concurrency
    ) {
      launch(nextToLaunch);
    }
  };

  fillWindow();

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (downloadController.signal.aborted) {
          cleanup();
          controller.error(createAbortError());
          return;
        }
        if (nextToEmit >= config.totalParts) {
          cleanup();
          controller.close();
          return;
        }

        fillWindow();
        const outcome = await outcomes.get(nextToEmit);
        outcomes.delete(nextToEmit);
        if (!outcome || outcome.ok === false) {
          abortAll();
          controller.error(
            outcome && outcome.ok === false
              ? outcome.error
              : new Error("Missing direct download range"),
          );
          return;
        }

        nextToEmit++;
        controller.enqueue(outcome.bytes);
      },
      cancel() {
        abortAll();
      },
    },
    { highWaterMark: 0 },
  );

  return { stream, config };
};

type UrlAuthorization = {
  url: string;
  candidates?: Array<{ url: string }>;
};
type FetchImplementation = (
  _input: string,
  _init: RequestInit,
) => Promise<Response>;

/**
 * Build a range fetcher around the available bearer URLs. Concurrent 403
 * responses share one refresh promise, so the authenticated control-plane
 * endpoint is invoked once for the logical download rather than once per lane.
 */
export const createRefreshingDirectRangeFetcher = <
  Authorization extends UrlAuthorization,
>({
  initialAuthorization,
  refreshAuthorization,
  fetchImplementation = (input, init) => fetch(input, init),
}: {
  initialAuthorization: Authorization;
  refreshAuthorization: (
    _stale: Authorization,
    _signal: AbortSignal,
  ) => Promise<Authorization>;
  fetchImplementation?: FetchImplementation;
}): DirectDownloadRangeFetcher => {
  let currentAuthorization = initialAuthorization;
  let refreshPromise: Promise<Authorization> | null = null;

  const getUrls = (authorization: Authorization): string[] => {
    const urls = (authorization.candidates || [])
      .map((candidate) => candidate.url)
      .filter((url) => typeof url === "string" && url.length > 0);
    return urls.length > 0 ? Array.from(new Set(urls)) : [authorization.url];
  };
  const getAuthorizationKey = (authorization: Authorization): string =>
    getUrls(authorization).join("\n");

  const refreshOnce = (
    stale: Authorization,
    signal: AbortSignal,
  ): Promise<Authorization> => {
    if (getAuthorizationKey(currentAuthorization) !== getAuthorizationKey(stale)) {
      return Promise.resolve(currentAuthorization);
    }
    if (!refreshPromise) {
      refreshPromise = refreshAuthorization(stale, signal)
        .then((fresh) => {
          currentAuthorization = fresh;
          return fresh;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };

  return async (range, signal) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw createAbortError();
      const usedAuthorization = currentAuthorization;
      const urls = getUrls(usedAuthorization);
      const requestUrl = urls[range.index % urls.length];
      const response = await fetchImplementation(requestUrl, {
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        headers: {
          Accept: "application/octet-stream",
          Range: `bytes=${range.start}-${range.end}`,
        },
        signal,
      });
      if (response.status !== 403 || attempt > 0) return response;
      await response.body?.cancel().catch(() => undefined);
      await refreshOnce(usedAuthorization, signal);
    }
    throw new Error("Direct range authorization refresh failed");
  };
};
