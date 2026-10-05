import crypto from "node:crypto";
import { once } from "node:events";

const MAX_MESSAGE = 256 * 1024;
const MAX_RESPONSE = 1024 * 1024 - 1;
const MAX_PENDING = 16;
const MAX_SESSIONS = 64;
const MAX_DOWNLOADS = 8;
const MAX_OWNED_JOBS = 256;
const CHUNK_SIZE = 192 * 1024;
const DOWNLOAD_IDLE_MS = 60_000;

function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

// One instance belongs to one browser native port. Credentials, authorizations
// and transfer readers stay in memory and disappear when the port closes.
export async function runNativeTransport(
  adapter,
  input = process.stdin,
  output = process.stdout,
) {
  const sessions = new Map();
  const downloads = new Map();
  const owners = new Map();
  const pending = new Set();
  const lifetime = new AbortController();
  let writes = Promise.resolve();

  const closeDownload = async (id) => {
    const download = downloads.get(id);
    if (!download) return;
    downloads.delete(id);
    download.controller.abort();
    await download.reader.cancel().catch(() => undefined);
  };

  const cleanup = () => {
    const cutoff = Date.now();
    for (const [id, download] of downloads) {
      if (download.expiresAt <= cutoff) void closeDownload(id);
    }
    // Keep expired sessions briefly so a fresh grant can renew the same owner.
    for (const [token, session] of sessions) {
      if (session.expiresAt + 20 * 60_000 <= cutoff) sessions.delete(token);
    }
    for (const id of owners.keys()) {
      if (!adapter.hasJob(id)) owners.delete(id);
    }
  };
  const timer = setInterval(cleanup, 10_000);
  timer.unref();

  async function handle(message) {
    const id =
      typeof message?.id === "string" &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(message.id)
        ? message.id
        : null;
    try {
      if (!id || !message || typeof message !== "object")
        throw failure("bad_request");
      const origin = message.origin;
      if (typeof origin !== "string" || !adapter.allowedOrigins.has(origin))
        throw failure("native_origin_denied", 403);
      const payload = message.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw failure("bad_request");
      cleanup();
      if (message.type === "health") {
        return {
          id,
          ok: true,
          result: {
            ...adapter.health(),
            paired: [...sessions.values()].some(
              (session) =>
                session.origin === origin && session.expiresAt > Date.now(),
            ),
            nativeTransportVersion: 1,
          },
        };
      }
      if (message.type === "authorize") {
        const expiresAt = await adapter.authorize(payload, origin);
        const previous = sessions.get(payload.sessionToken);
        const token =
          previous?.origin === origin
            ? payload.sessionToken
            : crypto.randomBytes(32).toString("base64url");
        if (!previous && sessions.size >= MAX_SESSIONS)
          throw failure("native_busy", 429);
        sessions.set(token, { origin, expiresAt });
        return { id, ok: true, result: { token, expiresAt } };
      }
      const token = payload.sessionToken;
      const session = typeof token === "string" ? sessions.get(token) : null;
      if (
        !session ||
        session.origin !== origin ||
        session.expiresAt <= Date.now()
      )
        throw failure("native_session_expired", 401);
      let result;
      switch (message.type) {
        case "webdav.list":
          result = await adapter.list(
            payload,
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(45_000)]),
          );
          break;
        case "webdav.upload.start":
          if (owners.size >= MAX_OWNED_JOBS) throw failure("native_busy", 429);
          result = adapter.createJob(payload, origin);
          owners.set(result.id, token);
          break;
        case "jobs.get":
        case "jobs.cancel": {
          const jobId = String(payload.jobId || "");
          if (owners.get(jobId) !== token) throw failure("job_not_found", 404);
          result = adapter.job(jobId, message.type === "jobs.cancel");
          break;
        }
        case "webdav.download.open": {
          if (downloads.size >= MAX_DOWNLOADS)
            throw failure("native_busy", 429);
          // Reserve a slot before awaiting the upstream connection.
          const downloadId = crypto.randomUUID();
          const controller = new AbortController();
          const openingTimeout = setTimeout(() => controller.abort(), 45_000);
          const download = {
            token,
            controller,
            reader: { cancel: async () => {} },
            expiresAt: Date.now() + DOWNLOAD_IDLE_MS,
            reading: false,
            remainder: null,
          };
          downloads.set(downloadId, download);
          try {
            const response = await adapter.download(
              payload,
              AbortSignal.any([controller.signal, lifetime.signal]),
            );
            if (!response.body || controller.signal.aborted)
              throw failure("webdav_upstream_error", 502);
            download.reader = response.body.getReader();
            download.expiresAt = Date.now() + DOWNLOAD_IDLE_MS;
            result = {
              downloadId,
              contentType:
                response.headers.get("content-type") ||
                "application/octet-stream",
              chunkSize: CHUNK_SIZE,
            };
          } catch (error) {
            await closeDownload(downloadId);
            throw error;
          } finally {
            clearTimeout(openingTimeout);
          }
          break;
        }
        case "webdav.download.read":
        case "webdav.download.close": {
          const downloadId = String(payload.downloadId || "");
          const download = downloads.get(downloadId);
          if (!download || download.token !== token)
            throw failure("native_download_expired", 404);
          if (message.type === "webdav.download.close") {
            await closeDownload(downloadId);
            result = { closed: true };
            break;
          }
          if (download.reading) throw failure("native_busy", 409);
          download.reading = true;
          download.expiresAt = Date.now() + DOWNLOAD_IDLE_MS;
          const readingTimeout = setTimeout(
            () => download.controller.abort(),
            45_000,
          );
          try {
            // Fill one native frame from small network packets. The browser pays
            // one IPC round trip per frame, while buffering stays at CHUNK_SIZE.
            const bytes = Buffer.allocUnsafe(CHUNK_SIZE);
            let length = 0;
            let done = false;
            while (length < CHUNK_SIZE) {
              const part = download.remainder
                ? { value: download.remainder, done: false }
                : await download.reader.read();
              download.remainder = null;
              if (part.done) {
                done = true;
                break;
              }
              const incoming = Buffer.from(
                part.value.buffer,
                part.value.byteOffset,
                part.value.byteLength,
              );
              const count = Math.min(CHUNK_SIZE - length, incoming.length);
              incoming.copy(bytes, length, 0, count);
              length += count;
              if (count < incoming.length)
                download.remainder = incoming.subarray(count);
            }
            result = {
              data: bytes.subarray(0, length).toString("base64"),
              done,
            };
            if (done) await closeDownload(downloadId);
          } catch (error) {
            await closeDownload(downloadId);
            throw error;
          } finally {
            clearTimeout(readingTimeout);
            download.reading = false;
          }
          break;
        }
        default:
          throw failure("bad_request");
      }
      return { id, ok: true, result };
    } catch (error) {
      const safe = adapter.error(error);
      return { id, ok: false, error: safe };
    }
  }

  function write(message) {
    writes = writes.then(async () => {
      let body = Buffer.from(JSON.stringify(message));
      if (body.length > MAX_RESPONSE) {
        body = Buffer.from(
          JSON.stringify({
            id: message.id,
            ok: false,
            error: adapter.error(failure("message_too_large", 413)),
          }),
        );
      }
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      if (!output.write(Buffer.concat([header, body])))
        await once(output, "drain");
    });
    return writes;
  }

  let buffer = Buffer.alloc(0);
  try {
    // A single parser owns framing; async data listeners would race on buffer.
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (!length || length > MAX_MESSAGE) {
          await write({
            id: null,
            ok: false,
            error: adapter.error(failure("message_too_large", 413)),
          });
          return;
        }
        if (buffer.length < length + 4) break;
        const raw = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        let message;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          await write({
            id: null,
            ok: false,
            error: adapter.error(failure("bad_request")),
          });
          continue;
        }
        if (pending.size >= MAX_PENDING) await Promise.race(pending);
        const task = handle(message).then(write);
        pending.add(task);
        void task.finally(() => pending.delete(task)).catch(() => undefined);
      }
    }
    if (buffer.length)
      await write({
        id: null,
        ok: false,
        error: adapter.error(failure("bad_request")),
      });
    lifetime.abort();
    adapter.shutdown();
    await Promise.allSettled([...downloads.keys()].map(closeDownload));
    await Promise.all(pending);
    await writes;
  } finally {
    clearInterval(timer);
    lifetime.abort();
    await Promise.allSettled([...downloads.keys()].map(closeDownload));
    adapter.shutdown();
    await Promise.allSettled(pending);
    await writes.catch(() => undefined);
    sessions.clear();
  }
}
