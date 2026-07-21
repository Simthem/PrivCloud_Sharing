interface ReencryptUploadRequest {
  shareId: string;
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  rotationId?: string;
  encryptionChunkSize: number;
  sessionId?: string;
}

interface WorkerResult {
  type: "result";
  requestId: number;
  ok: boolean;
  status?: number;
  message?: string;
  data?: unknown;
  chunk?: ArrayBuffer;
}

interface PendingUpload {
  resolve: () => void;
  reject: (_error: Error & {
    status?: number;
    data?: unknown;
    chunk?: ArrayBuffer;
  }) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingUploads = new Map<number, PendingUpload>();

const rejectPendingUploads = (message: string) => {
  for (const pending of pendingUploads.values()) {
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    pending.reject(new Error(message));
  }
  pendingUploads.clear();
};

const getWorker = (): Worker => {
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    throw new Error("Web Worker is unavailable for key rotation");
  }

  worker = new Worker("/reencrypt-worker.js?v=20260714-1");
  worker.addEventListener("message", (event: MessageEvent<WorkerResult>) => {
    const result = event.data;
    if (result.type !== "result") return;
    const pending = pendingUploads.get(result.requestId);
    if (!pending) return;

    pendingUploads.delete(result.requestId);
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    if (result.ok) {
      pending.resolve();
      return;
    }

    const error: Error & {
      status?: number;
      data?: unknown;
      chunk?: ArrayBuffer;
    } = new Error(result.message || "Re-encryption upload failed");
    error.status = result.status;
    error.data = result.data;
    error.chunk = result.chunk;
    pending.reject(error);
  });
  worker.addEventListener("error", () => {
    rejectPendingUploads("Key rotation worker crashed");
    worker?.terminate();
    worker = null;
  });
  return worker;
};

/** Upload one encrypted transport chunk outside the renderer isolate. */
export const uploadReencryptChunkInWorker = (
  request: ReencryptUploadRequest,
  chunk: ArrayBuffer,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  const activeWorker = getWorker();
  const requestId = nextRequestId++;

  return new Promise((resolve, reject) => {
    const abortHandler = () => {
      activeWorker.postMessage({ type: "abort", requestId });
      pendingUploads.delete(requestId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    pendingUploads.set(requestId, {
      resolve,
      reject,
      signal,
      abortHandler,
    });
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      activeWorker.postMessage(
        { type: "upload", requestId, ...request, chunk },
        [chunk],
      );
    } catch (error) {
      pendingUploads.delete(requestId);
      signal?.removeEventListener("abort", abortHandler);
      reject(error);
    }
  });
};
