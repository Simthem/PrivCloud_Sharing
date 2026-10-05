export interface WorkerResult {
  type: "result";
  requestId: number;
  ok: boolean;
  status?: number;
  message?: string;
  data?: unknown;
  chunk?: ArrayBuffer;
}

const isWorkerResult = (value: unknown): value is WorkerResult => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkerResult>;
  return (
    candidate.type === "result" &&
    Number.isSafeInteger(candidate.requestId) &&
    Number(candidate.requestId) > 0 &&
    typeof candidate.ok === "boolean" &&
    (candidate.status === undefined ||
      (Number.isInteger(candidate.status) &&
        candidate.status >= 0 &&
        candidate.status <= 599)) &&
    (candidate.message === undefined ||
      typeof candidate.message === "string") &&
    (candidate.chunk === undefined || candidate.chunk instanceof ArrayBuffer)
  );
};

/**
 * Dedicated Worker messages have an empty origin. The exact Worker target,
 * browser trust bit and full payload shape together form the trust boundary.
 */
export const isTrustedWorkerResultEvent = (
  event: MessageEvent<unknown>,
  expectedWorker: Worker,
): event is MessageEvent<WorkerResult> =>
  event.origin === "" &&
  event.isTrusted &&
  event.currentTarget === expectedWorker &&
  event.target === expectedWorker &&
  isWorkerResult(event.data);
