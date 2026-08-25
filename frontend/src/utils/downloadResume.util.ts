export type DownloadRangeReopener = (_offset: number) => Promise<Response>;

export type ResumableDownloadOptions = {
  maxResumeAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

const DEFAULT_MAX_RESUME_ATTEMPTS = 12;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

const waitForRetry = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
};

/**
 * Preserve one logical byte stream when its HTTP response is interrupted.
 *
 * Reopened responses must start at the exact number of bytes already exposed
 * to the consumer. The returned stream therefore remains safe underneath an
 * E2E record decoder: a partial crypto record is completed by the next range
 * response instead of being duplicated or skipped.
 */
export function createResumableDownloadBody(
  initialResponse: Response,
  reopenRange: DownloadRangeReopener,
  signal?: AbortSignal,
  options: ResumableDownloadOptions = {},
): { stream: ReadableStream<Uint8Array>; totalSize: number } {
  const totalSize = Number(initialResponse.headers.get("Content-Length") || 0);
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new Error("Invalid download length");
  }
  if (!initialResponse.body) throw new Error("Response has no body");

  const maxResumeAttempts = Math.max(
    0,
    Math.floor(options.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS),
  );
  const retryBaseDelayMs = Math.max(
    0,
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
  );

  let reader = initialResponse.body.getReader();
  let received = 0;
  let resumeAttempts = 0;
  let cancelled = false;

  const reopen = async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    try {
      await reader.cancel();
    } catch {
      /* the failed transport may already be closed */
    }

    let lastReopenError: unknown;
    while (resumeAttempts < maxResumeAttempts) {
      resumeAttempts++;
      const delayMs = Math.min(
        retryBaseDelayMs * Math.pow(2, resumeAttempts - 1),
        retryMaxDelayMs,
      );
      await waitForRetry(delayMs, signal);

      let resumed: Response;
      try {
        resumed = await reopenRange(received);
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          throw error;
        }
        lastReopenError = error;
        continue;
      }

      const contentRange = resumed.headers.get("Content-Range") || "";
      const parsedRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      const rangeStart = parsedRange ? Number(parsedRange[1]) : -1;
      const rangeEnd = parsedRange ? Number(parsedRange[2]) : -1;
      const rangeTotal = parsedRange ? Number(parsedRange[3]) : -1;
      if (
        resumed.status !== 206 ||
        !parsedRange ||
        rangeStart !== received ||
        rangeEnd < rangeStart ||
        rangeEnd >= totalSize ||
        rangeTotal !== totalSize ||
        !resumed.body
      ) {
        await resumed.body?.cancel().catch(() => undefined);
        throw new Error("Server returned an invalid download resume range");
      }
      reader = resumed.body.getReader();
      return;
    }

    const detail =
      lastReopenError instanceof Error ? `: ${lastReopenError.message}` : "";
    throw new Error(
      `Download interrupted after ${maxResumeAttempts} resume attempts${detail}`,
    );
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled) {
        if (signal?.aborted) {
          controller.error(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (received >= totalSize) {
          controller.close();
          return;
        }

        try {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error("Download stream ended before its declared size");
          }
          if (!value || value.length === 0) continue;

          received += value.length;
          if (received > totalSize) {
            throw new Error("Download response exceeded its declared size");
          }
          controller.enqueue(value);
          return;
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            controller.error(error);
            return;
          }
          try {
            await reopen();
          } catch (resumeError) {
            controller.error(resumeError);
            return;
          }
        }
      }
    },
    async cancel() {
      cancelled = true;
      try {
        await reader.cancel();
      } catch {
        /* ignored */
      }
    },
  });

  return { stream, totalSize };
}
