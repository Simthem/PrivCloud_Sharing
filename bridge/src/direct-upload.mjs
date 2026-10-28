import crypto from "node:crypto";

const MIN_PART_BYTES = 5 * 1024 * 1024;
const WORKING_MEMORY_BYTES = 128 * 1024 * 1024;
const acquirePartSlot = createUploadSlots(4);

function uploadError(status, code = "privcloud_upload_rejected") {
  return Object.assign(new Error(`Upload failed with HTTP ${status}`), {
    statusCode: status,
    code,
  });
}

function wait(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Stream one WebDAV file to authorized S3 parts, with bounded shared PUT capacity. */
export async function uploadDirectFile({
  appBaseUrl,
  shareId,
  uploadToken,
  metadata,
  fileSize,
  chunkSize,
  encrypted = false,
  // 2: E2EE content v2, 1 MB records and a 32-byte header before part 1.
  contentScheme = 1,
  chunks,
  transform = (chunk) => chunk,
  signal,
  onProgress = () => {},
  cancelSource = () => {},
  fetchImpl = fetch,
}) {
  if (chunkSize < MIN_PART_BYTES || fileSize <= 0) return false;
  const totalChunks = Math.ceil(fileSize / chunkSize);
  const contentV2 = encrypted && contentScheme === 2;
  const layout = {
    ...metadata,
    fileSize,
    chunkSize,
    initialChunkSize: chunkSize,
    totalChunks,
    ...(encrypted && {
      encryptionChunkSize: contentV2 ? CONTENT_V2_RECORD_SIZE : chunkSize,
    }),
    ...(contentV2 && { contentScheme: 2 }),
  };
  const bodyLength = (index, plainLength) =>
    !encrypted
      ? plainLength
      : contentV2
        ? plainLength +
          Math.max(1, Math.ceil(plainLength / CONTENT_V2_RECORD_SIZE)) * 28 +
          (index === 0 ? CONTENT_V2_HEADER_LENGTH : 0)
        : plainLength + 28;
  const lifetime = new AbortController();
  const transferSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;
  const controlBase = new URL(
    `/api/shares/${encodeURIComponent(shareId)}/files/bridge/multipart/`,
    appBaseUrl,
  );
  const request = async (action, body, optional = false) => {
    for (let attempt = 0; ; attempt++) {
      transferSignal.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(new URL(action, controlBase), {
          method: "POST",
          redirect: "manual",
          credentials: "omit",
          headers: {
            Authorization: `Bearer ${uploadToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            transferSignal,
            AbortSignal.timeout(60_000),
          ]),
        });
      } catch (error) {
        transferSignal.throwIfAborted();
        if (attempt >= 3) throw error;
      }
      if (response?.ok) return response.json();
      if (optional && [404, 405, 501].includes(response?.status)) {
        await response.body?.cancel();
        return null;
      }
      if (response) {
        await response.body?.cancel();
        if (
          attempt >= 3 ||
          ![408, 429, 500, 502, 503, 504].includes(response.status)
        )
          throw uploadError(response.status);
      }
      await wait(250 * 2 ** attempt, transferSignal);
    }
  };
  const initialized = await request("init", layout, true);
  // An older API or local/relay-only storage keeps the established relay path.
  if (!initialized || initialized.uploadTransport !== "direct-s3") return false;
  const lanes = Math.max(
    1,
    Math.min(
      4,
      Math.floor(Number(initialized.uploadConcurrency) || 1),
      // Reserve three source/crypto buffers and two buffers per live PUT.
      Math.max(1, Math.floor((WORKING_MEMORY_BYTES / chunkSize - 3) / 2)),
    ),
  );
  const pending = new Set();
  let failure;
  let completed = false;
  let bytesRead = 0;
  let index = 0;
  const iterator = chunks[Symbol.asyncIterator]();
  const putPart = async (body, chunkIndex, plainBytes) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      transferSignal.throwIfAborted();
      const authorization = await request("part-urls", {
        ...layout,
        parts: [{ chunkIndex, contentLength: body.length }],
      });
      const part = authorization?.parts?.[0];
      if (
        part?.partNumber !== chunkIndex + 1 ||
        part?.contentLength !== body.length
      )
        throw new Error("Invalid S3 part authorization");
      const candidates = part.candidates?.length
        ? part.candidates
        : [{ url: part.url }];
      let lastError;
      for (const candidate of candidates) {
        const url = new URL(candidate.url);
        const localHttp =
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (
          (url.protocol !== "https:" && !localHttp) ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error("Invalid S3 upload URL");
        const releasePart = await acquirePartSlot(transferSignal);
        try {
          const response = await fetchImpl(url, {
            method: "PUT",
            body,
            redirect: "manual",
            credentials: "omit",
            headers: { "Content-Length": String(body.length) },
            signal: AbortSignal.any([
              transferSignal,
              AbortSignal.timeout(120_000),
            ]),
          });
          await response.body?.cancel();
          if (response.ok) {
            onProgress(plainBytes);
            return;
          }
          lastError = uploadError(response.status, "s3_upload_rejected");
          if (
            ![401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)
          )
            throw lastError;
        } catch (error) {
          transferSignal.throwIfAborted();
          if (
            error?.statusCode &&
            ![401, 403, 408, 429, 500, 502, 503, 504].includes(error.statusCode)
          )
            throw error;
          lastError = error;
        } finally {
          releasePart();
        }
      }
      if (attempt === 3) throw lastError || new Error("No S3 upload URL");
      await wait(250 * 2 ** attempt, transferSignal);
    }
  };
  try {
    while (index < totalChunks) {
      if (pending.size >= lanes) await Promise.race(pending);
      if (failure) throw failure;
      transferSignal.throwIfAborted();
      const { value: plain, done } = await iterator.next();
      const expected = Math.min(chunkSize, fileSize - bytesRead);
      if (done || plain.length !== expected)
        throw new Error("WebDAV size changed during upload");
      bytesRead += plain.length;
      const body = transform(plain);
      if (body.length !== bodyLength(index, plain.length))
        throw new Error("Invalid encrypted record size");
      let task;
      task = putPart(body, index++, plain.length)
        .catch((error) => {
          failure ||= error;
          lifetime.abort(error);
          cancelSource(error);
        })
        .finally(() => pending.delete(task));
      pending.add(task);
    }
    if (!(await iterator.next()).done)
      throw new Error("WebDAV file exceeds declared size");
    await Promise.all(pending);
    if (failure) throw failure;
    await request("complete", layout);
    completed = true;
    return true;
  } catch (error) {
    failure ||= error;
    throw error;
  } finally {
    lifetime.abort();
    if (!completed) cancelSource(failure);
    await iterator.return?.();
    await Promise.allSettled(pending);
  }
}

/** Bound live managed jobs across tabs as well as parts within each job. */
export function createUploadSlots(limit = 2) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      entry.signal.removeEventListener("abort", entry.abort);
      active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  };
  return (signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const entry = {
        signal,
        resolve,
        abort: () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      queue.push(entry);
      drain();
    });
}

/** Run two files per job, stopping and draining siblings on the first error. */
export async function runParallelFiles(count, uploadFile, controller) {
  let next = 0;
  let failure;
  const worker = async () => {
    while (next < count && !controller.signal.aborted) {
      const index = next++;
      try {
        await uploadFile(index);
      } catch (error) {
        failure ||= controller.signal.aborted
          ? controller.signal.reason
          : error;
        controller.abort(failure);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, count) }, worker));
  if (failure) throw failure;
  controller.signal.throwIfAborted();
}

// ---- E2EE content v2 writer, docs/E2EE_CONTENT_V2.md ----
// Same layout, key derivation and additional data as the web reader in
// frontend/src/utils/contentV2.util.ts. frontend/test/content-v2-writers.test.mjs
// reads what this writer produces with that reader.
export const CONTENT_V2_RECORD_SIZE = 1_000_000;
const CONTENT_V2_HEADER_LENGTH = 32;
const CONTENT_V2_MAGIC = Buffer.from([
  0x89, 0x50, 0x43, 0x45, 0x32, 0x0d, 0x0a, 0x1a,
]);

function contentField(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * Seals the records of one v2 file in any order. Record `index` covers
 * plaintext bytes [index * 1 MB, (index + 1) * 1 MB) of the file.
 */
export function openContentV2Writer(
  key,
  fileId,
  size,
  nonce = crypto.randomBytes(16),
) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid v2 content size");
  }
  const records = Math.max(1, Math.ceil(size / CONTENT_V2_RECORD_SIZE));
  const header = Buffer.alloc(CONTENT_V2_HEADER_LENGTH);
  CONTENT_V2_MAGIC.copy(header, 0);
  header[8] = 2;
  header.writeUInt32BE(CONTENT_V2_RECORD_SIZE, 10);
  Buffer.from(nonce).copy(header, 14);
  const identity = Buffer.concat([
    contentField("share-file"),
    contentField(fileId),
  ]);
  const fileKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      key,
      Buffer.alloc(0),
      Buffer.concat([
        contentField("privcloud:content:v2:key"),
        header,
        identity,
      ]),
      32,
    ),
  );
  const recordLabel = contentField("privcloud:content:v2:record");
  return {
    header,
    records,
    sealRecord(index, plain) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= records) {
        throw new Error("Record out of range");
      }
      const last = index === records - 1;
      const expected = last
        ? size - index * CONTENT_V2_RECORD_SIZE
        : CONTENT_V2_RECORD_SIZE;
      if (plain.length !== expected) {
        throw new Error("Record length does not match the content size");
      }
      const position = Buffer.alloc(9);
      position.writeBigUInt64BE(BigInt(index));
      position[8] = last ? 1 : 0;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", fileKey, iv);
      cipher.setAAD(Buffer.concat([recordLabel, header, identity, position]));
      return Buffer.concat([
        iv,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
  };
}

/**
 * Body of one transport chunk: the header before the first one, then its
 * records. Chunks hold whole 1 MB records and start at `offset` in the file.
 */
export function encryptContentV2Chunk(writer, plain, offset) {
  if (offset % CONTENT_V2_RECORD_SIZE !== 0) {
    throw new Error("v2 chunks must start on a record boundary");
  }
  const first = offset / CONTENT_V2_RECORD_SIZE;
  const parts = offset === 0 ? [writer.header] : [];
  const count = Math.max(1, Math.ceil(plain.length / CONTENT_V2_RECORD_SIZE));
  for (let index = 0; index < count; index++) {
    parts.push(
      writer.sealRecord(
        first + index,
        plain.subarray(
          index * CONTENT_V2_RECORD_SIZE,
          (index + 1) * CONTENT_V2_RECORD_SIZE,
        ),
      ),
    );
  }
  return Buffer.concat(parts);
}
