import { scheduleUploadTimeout } from "./uploadClock.util";

type UploadAttemptResult = "ok" | "failed" | "retryable";

type UploadQueueOptions<T> = {
  schedule: (
    _attempt: () => Promise<UploadAttemptResult>,
  ) => Promise<UploadAttemptResult>;
  upload: (_item: T) => Promise<UploadAttemptResult>;
  onRetry: (_item: T) => number;
  signal: AbortSignal;
  wait?: (_delayMs: number, _signal: AbortSignal) => Promise<void>;
};

export function waitForUploadRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      timer();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = scheduleUploadTimeout(finish, Math.max(0, delayMs));
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Retry each file while siblings continue, releasing its slot during backoff. */
export async function runUploadQueue<T>(
  items: T[],
  options: UploadQueueOptions<T>,
): Promise<void> {
  const wait = options.wait ?? waitForUploadRetry;
  const results = await Promise.allSettled(
    items.map(async (item) => {
      while (!options.signal.aborted) {
        const result = await options.schedule(() =>
          options.signal.aborted
            ? Promise.resolve("failed")
            : options.upload(item),
        );
        if (result !== "retryable" || options.signal.aborted) return;
        await wait(options.onRetry(item), options.signal);
      }
    }),
  );
  // Finalization must wait for every worker, even if a scheduling callback fails.
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
