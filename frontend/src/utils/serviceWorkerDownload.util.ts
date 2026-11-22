// Hands a file decrypted in this page to the service worker, which serves it
// as a regular download: the browser shows it in its downloads with progress.
// The key never leaves the page, only plaintext pieces cross the channel.

export const SERVICE_WORKER_PIECE_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 1500;
const CONTROLLER_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 10_000;
const CLEANUP_DELAY_MS = 30_000;

export type DownloadSink = {
  setSize(_size: number | null): void;
  write(_data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

const has = (value: unknown, field: string) =>
  value !== null &&
  typeof value === "object" &&
  Reflect.ownKeys(value).length === 1 &&
  Object.prototype.hasOwnProperty.call(value, field) &&
  (value as Record<string, unknown>)[field] === true;

const isPrivateMessage = (event: MessageEvent<unknown>) =>
  event.origin === "" && event.ports.length === 0;

/**
 * Without a save picker the worker is the only way to stream to disk, so a
 * page not controlled yet (first visit, forced reload) waits for it.
 */
async function waitForController(): Promise<ServiceWorker | null> {
  const container = navigator.serviceWorker;
  if (container.controller) return container.controller;
  if ("showSaveFilePicker" in window) return null;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", done);
      resolve(container.controller);
    };
    const timer = setTimeout(done, CONTROLLER_TIMEOUT_MS);
    container.addEventListener("controllerchange", done);
    container
      .register("/sw.js")
      .then(() => container.ready)
      .then((registration) => {
        if (container.controller) done();
        else
          registration.active?.postMessage({
            type: "privcloud-preview-claim",
          });
      })
      .catch(done);
  });
}

/**
 * Null when no up to date service worker controls the page. The caller then
 * keeps its previous path, so this never blocks a download.
 */
export async function openServiceWorkerDownload(
  fileName: string,
): Promise<DownloadSink | null> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof ReadableStream === "undefined"
  )
    return null;
  const worker = await waitForController();
  if (!worker) return null;
  const channel = new MessageChannel();
  const port = channel.port1;
  const token = crypto.randomUUID();

  // A worker installed before this feature ignores the offer.
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    port.onmessage = (event: MessageEvent<unknown>) => {
      if (!isPrivateMessage(event) || !has(event.data, "ready")) return;
      clearTimeout(timer);
      resolve(true);
    };
    port.start();
    worker.postMessage({ type: "privcloud-download-offer", token }, [
      channel.port2,
    ]);
  });
  if (!ready) {
    port.onmessage = null;
    port.close();
    return null;
  }

  const queue: Uint8Array[] = [];
  let size: number | null | undefined;
  let metadataAsked = false;
  let pullPending = false;
  let finished = false;
  let failed = false;
  let cancelled = false;
  let stalled = false;
  let drained: (() => void)[] = [];

  const ping = setInterval(() => {
    navigator.serviceWorker.controller?.postMessage({
      type: "privcloud-download-ping",
    });
  }, PING_INTERVAL_MS);
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");

  const wake = () => {
    drained.forEach((resolve) => resolve());
    drained = [];
  };

  const release = () => {
    clearInterval(ping);
    clearTimeout(startTimer);
    setTimeout(() => {
      frame.remove();
      port.close();
    }, CLEANUP_DELAY_MS);
    wake();
  };

  const answerMetadata = () => {
    if (!metadataAsked || size === undefined) return;
    metadataAsked = false;
    port.postMessage({ name: fileName.slice(0, 255) || "download", size });
  };

  const setSize = (value: number | null) => {
    if (size !== undefined) return;
    size =
      value !== null && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    answerMetadata();
  };

  const send = () => {
    if (!pullPending) return;
    if (failed) {
      pullPending = false;
      port.postMessage({ error: true });
      release();
      return;
    }
    const piece = queue.shift();
    if (piece) {
      pullPending = false;
      port.postMessage({ bytes: piece.buffer }, [piece.buffer]);
    } else if (finished) {
      pullPending = false;
      port.postMessage({ done: true });
      release();
    }
    if (queue.length === 0) wake();
  };

  port.onmessage = (event: MessageEvent<unknown>) => {
    if (!isPrivateMessage(event)) return;
    if (has(event.data, "metadata")) {
      clearTimeout(startTimer);
      metadataAsked = true;
      answerMetadata();
    } else if (has(event.data, "next")) {
      pullPending = true;
      send();
    } else if (has(event.data, "close") && !finished && !failed) {
      // Cancelled or failed in the browser downloads.
      cancelled = true;
      queue.length = 0;
      release();
    }
  };
  // The browser never requested the file, a blocked download for instance.
  const startTimer = setTimeout(() => {
    stalled = true;
    queue.length = 0;
    release();
  }, START_TIMEOUT_MS);
  frame.src = `/__privcloud_download__/${token}`;
  document.body.appendChild(frame);

  const abortError = () =>
    stalled
      ? new Error("The browser did not start the download")
      : new DOMException("Aborted", "AbortError");

  return {
    setSize,
    async write(data) {
      if (cancelled || failed || stalled) throw abortError();
      if (size === undefined) setSize(null);
      for (
        let offset = 0;
        offset < data.length;
        offset += SERVICE_WORKER_PIECE_BYTES
      ) {
        queue.push(data.slice(offset, offset + SERVICE_WORKER_PIECE_BYTES));
      }
      send();
      if (queue.length > 0) {
        await new Promise<void>((resolve) => drained.push(resolve));
      }
      if (cancelled || stalled) throw abortError();
    },
    async close() {
      if (cancelled || stalled) throw abortError();
      if (size === undefined) setSize(null);
      finished = true;
      send();
    },
    async abort() {
      if (finished || cancelled || failed || stalled) return;
      failed = true;
      queue.length = 0;
      if (size === undefined) setSize(null);
      if (pullPending) send();
      else {
        port.postMessage({ error: true });
        release();
      }
    },
  };
}
