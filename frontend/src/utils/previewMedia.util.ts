import {
  PREVIEW_READ_AHEAD_BYTES,
  PREVIEW_READ_BYTES,
  type PreviewByteSource,
} from "./previewRange.util";

const sessions = new Map<
  string,
  { source: PreviewByteSource; mimeType: string; abort: AbortController }
>();
let listening = false;
let workerReady: Promise<void> | undefined;

function hasFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

async function ensurePreviewWorker() {
  if (!("serviceWorker" in navigator))
    throw new Error("Progressive media preview is unavailable in this browser");
  if (!listening) {
    listening = true;
    navigator.serviceWorker.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        if (event.origin !== String(window.location.origin)) return;
        if (
          event.isTrusted !== true ||
          event.currentTarget !== navigator.serviceWorker ||
          !navigator.serviceWorker.controller ||
          event.source !== navigator.serviceWorker.controller ||
          event.ports.length !== 1 ||
          !(event.ports[0] instanceof MessagePort)
        )
          return;
        const port = event.ports[0];
        const data = event.data;
        if (
          !hasFields(data, ["type", "token"]) ||
          data.type !== "privcloud-preview" ||
          typeof data.token !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            data.token,
          )
        ) {
          port.close();
          return;
        }
        const session = sessions.get(data.token);
        if (!session) {
          port.postMessage({ error: true });
          port.close();
          return;
        }
        const request = new AbortController();
        // Records prepared ahead of this response. A seek closes the response,
        // which drops whatever this one had not consumed yet.
        const ahead = new AbortController();
        let reading = false;
        const abort = () => {
          session.abort.signal.removeEventListener("abort", abort);
          request.abort();
          ahead.abort();
          port.onmessage = null;
          port.close();
        };
        session.abort.signal.addEventListener("abort", abort, { once: true });
        port.onmessage = async (message: MessageEvent<unknown>) => {
          // MessagePort events have an empty origin. Trust only this private port.
          if (message.origin !== "") return;
          if (
            message.isTrusted !== true ||
            message.currentTarget !== port ||
            message.source !== null ||
            message.ports.length !== 0 ||
            request.signal.aborted
          )
            return;
          const command = message.data;
          if (hasFields(command, ["close"]) && command.close === true) {
            abort();
            return;
          }
          if (
            reading ||
            !hasFields(command, ["start", "end"]) ||
            typeof command.start !== "number" ||
            typeof command.end !== "number" ||
            !Number.isSafeInteger(command.start) ||
            !Number.isSafeInteger(command.end) ||
            command.start < 0 ||
            command.end <= command.start ||
            command.end > session.source.size ||
            command.end - command.start > PREVIEW_READ_BYTES
          ) {
            port.postMessage({ error: true });
            abort();
            return;
          }
          reading = true;
          try {
            const bytes = await session.source.read(
              command.start,
              command.end,
              request.signal,
            );
            request.signal.throwIfAborted();
            // The worker asks for one window at a time and waits for it. Without
            // this, every MiB paid a full round trip and playback outran it.
            session.source.prefetch?.(
              command.end,
              command.end + PREVIEW_READ_AHEAD_BYTES,
              ahead.signal,
            );
            if (
              !(bytes.buffer instanceof ArrayBuffer) ||
              bytes.byteLength !== command.end - command.start
            )
              throw new Error("Invalid preview bytes");
            const buffer =
              bytes.byteOffset === 0 &&
              bytes.byteLength === bytes.buffer.byteLength
                ? bytes.buffer
                : bytes.buffer.slice(
                    bytes.byteOffset,
                    bytes.byteOffset + bytes.byteLength,
                  );
            port.postMessage({ bytes: buffer }, [buffer]);
          } catch {
            if (!request.signal.aborted) port.postMessage({ error: true });
            abort();
          } finally {
            reading = false;
          }
        };
        port.postMessage({
          size: session.source.size,
          mimeType: session.mimeType,
          chunkBytes: PREVIEW_READ_BYTES,
        });
      },
    );
  }
  if (!workerReady) {
    workerReady = new Promise<void>((resolve, reject) => {
      const ports = new Set<MessagePort>();
      let finished = false;
      // Covers registration too: a worker that never activates must end in
      // an error, not in an endless loader.
      const deadline = setTimeout(
        () => finish(new Error("Preview worker activation timed out")),
        15_000,
      );
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        for (const port of ports) port.close();
        ports.clear();
        navigator.serviceWorker.removeEventListener("controllerchange", check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        const worker = navigator.serviceWorker.controller;
        if (!worker || finished) return;
        const channel = new MessageChannel();
        const port = channel.port1;
        ports.add(port);
        port.onmessage = (event: MessageEvent<unknown>) => {
          if (event.origin !== "") return;
          if (
            event.isTrusted !== true ||
            event.currentTarget !== port ||
            event.source !== null ||
            event.ports.length !== 0 ||
            navigator.serviceWorker.controller !== worker ||
            !hasFields(event.data, ["previewVersion"]) ||
            event.data.previewVersion !== 2
          )
            return;
          ports.delete(port);
          channel.port1.close();
          finish();
        };
        worker.postMessage({ type: "privcloud-preview-version" }, [
          channel.port2,
        ]);
      };
      navigator.serviceWorker.addEventListener("controllerchange", check);
      if (navigator.serviceWorker.controller) check();
      (async () => {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          updateViaCache: "none",
        });
        // A failed update check leaves the active worker usable.
        void registration.update().catch(() => undefined);
        const ready = await navigator.serviceWorker.ready;
        if (finished) return;
        check();
        // After a forced reload the page stays uncontrolled until the active
        // worker claims it again.
        if (!navigator.serviceWorker.controller)
          ready.active?.postMessage({ type: "privcloud-preview-claim" });
      })().catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    }).catch((error) => {
      workerReady = undefined;
      throw error;
    });
  }
  await workerReady;
}

/** The worker receives bytes only. Keys and authorization stay in this page. */
export async function createProgressiveMediaUrl(
  source: PreviewByteSource,
  mimeType: string,
  signal: AbortSignal,
) {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size <= 0 ||
    !/^(?:audio|video)\/[a-z0-9.+-]+$/i.test(mimeType)
  )
    throw new Error("Invalid media preview metadata");
  await ensurePreviewWorker();
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const abort = new AbortController();
  sessions.set(token, { source, mimeType, abort });
  const release = () => {
    signal.removeEventListener("abort", release);
    abort.abort();
    sessions.delete(token);
  };
  signal.addEventListener("abort", release, { once: true });
  return { url: `/__privcloud_preview__/${token}`, release };
}
