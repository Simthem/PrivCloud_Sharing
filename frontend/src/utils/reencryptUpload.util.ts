import { isTrustedWorkerResultEvent } from "./reencryptWorkerMessage.util";

interface ReencryptUploadRequest {
  shareId: string;
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  rotationId?: string;
  encryptionChunkSize: number;
  sessionId?: string;
  /** Last chunk of a FILE_META_V1 file: its name under the new key. */
  encryptedMetadata?: string;
  /** E2EE content format of the rewritten file. */
  contentScheme?: 1 | 2;
}

interface PendingUpload {
  resolve: () => void;
  reject: (
    _error: Error & {
      status?: number;
      data?: unknown;
      chunk?: ArrayBuffer;
    },
  ) => void;
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

  const activeWorker = new Worker("/reencrypt-worker.js?v=20261027-2", {
    name: "privcloud-reencrypt-upload",
  });
  worker = activeWorker;
  activeWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
    // Dedicated Worker messages use an empty MessageEvent.origin by standard.
    // Binding the listener to the exact Worker object, requiring a trusted
    // browser event and validating the full payload prevents window or custom
    // MessageEvent data from entering the upload state machine.
    if (
      event.origin !== "" ||
      !isTrustedWorkerResultEvent(event, activeWorker)
    ) {
      return;
    }

    const result = event.data;
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
  activeWorker.addEventListener("error", () => {
    rejectPendingUploads("Key rotation worker crashed");
    activeWorker.terminate();
    if (worker === activeWorker) worker = null;
  });
  return activeWorker;
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
