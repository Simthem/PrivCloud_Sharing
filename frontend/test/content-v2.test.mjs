import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_V2_HEADER_LENGTH,
  CONTENT_V2_OVERHEAD,
  CONTENT_V2_RECORD_SIZE,
  ContentIntegrityError,
  contentV2Nonce,
  contentWriteScheme,
  encryptContentV2,
  hasContentV2Floor,
  openContentV2,
  openContentV2Writer,
} from "../src/utils/contentV2.util.ts";
import {
  arrayBufferToBase64Url,
  decryptFileAuto,
  decryptStream,
  encryptFile,
  exportKeyToBase64,
  generateEncryptionKey,
  importKeyFromBase64,
  reencryptStream,
  unwrapReverseShareKey,
  unwrapShareKey,
  wrapReverseShareKey,
  wrapShareKey,
} from "../src/utils/crypto.util.ts";
import { createPreviewByteSource } from "../src/utils/previewRange.util.ts";

const RS = CONTENT_V2_RECORD_SIZE;
const FULL = RS + CONTENT_V2_OVERHEAD;
const key = await generateEncryptionKey();
const fileA = { fileId: "file-a" };
const fileB = { fileId: "file-b" };
const signedA = { signingDocumentId: "file-a" };

const bytes = (length, seed) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const recordOf = (encrypted, index) =>
  encrypted.slice(
    CONTENT_V2_HEADER_LENGTH + index * FULL,
    CONTENT_V2_HEADER_LENGTH + (index + 1) * FULL,
  );
const headerOf = (encrypted) => encrypted.slice(0, CONTENT_V2_HEADER_LENGTH);

/** Network delivery in uneven fragments, as fetch hands them over. */
function streamOf(encrypted, fragment = 65_537) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= encrypted.length) return controller.close();
      controller.enqueue(encrypted.slice(offset, offset + fragment));
      offset += fragment;
    },
  });
}

async function readStream(
  encrypted,
  context = fileA,
  total = encrypted.length,
  readKey = key,
) {
  const parts = [];
  for await (const part of decryptStream(
    streamOf(encrypted),
    readKey,
    RS,
    total,
    true,
    undefined,
    context,
  )) {
    parts.push(part);
  }
  return concat(...parts);
}

const readAuto = async (encrypted, context = fileA, readKey = key) =>
  new Uint8Array(
    await decryptFileAuto(encrypted.slice().buffer, readKey, RS, context),
  );

function rangeFetcher(encrypted) {
  return async (start, end) =>
    new Response(encrypted.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${encrypted.length}`,
      },
    });
}

async function readPreview(
  encrypted,
  start,
  end,
  context = fileA,
  readKey = key,
) {
  const source = await createPreviewByteSource(
    rangeFetcher(encrypted),
    readKey,
    RS,
    undefined,
    context,
  );
  return { size: source.size, bytes: await source.read(start, end) };
}

const rejectsIntegrity = (promise) =>
  assert.rejects(promise, (error) => error instanceof ContentIntegrityError);

const plain = bytes(3 * RS + 17, 3);
const encrypted = await encryptContentV2(key, fileA, plain);

test("v2 content decrypts through the stream, buffer and preview readers", async () => {
  assert.equal(
    encrypted.length,
    CONTENT_V2_HEADER_LENGTH + plain.length + 4 * CONTENT_V2_OVERHEAD,
  );
  assert.deepEqual(await readStream(encrypted), plain);
  assert.deepEqual(await readAuto(encrypted), plain);
  const across = await readPreview(encrypted, RS - 5, RS + 1_000);
  assert.equal(across.size, plain.length);
  assert.deepEqual(across.bytes, plain.subarray(RS - 5, RS + 1_000));
  const tail = await readPreview(encrypted, plain.length - 17, plain.length);
  assert.deepEqual(tail.bytes, plain.subarray(plain.length - 17));
});

test("v2 boundary sizes keep a canonical layout", async () => {
  for (const length of [0, 1, RS - 1, RS, RS + 1, 2 * RS]) {
    const content = bytes(length, length & 0xff);
    const sealed = await encryptContentV2(key, fileA, content);
    const records = Math.max(1, Math.ceil(length / RS));
    assert.equal(
      sealed.length,
      CONTENT_V2_HEADER_LENGTH + length + records * CONTENT_V2_OVERHEAD,
    );
    assert.deepEqual(await readStream(sealed), content, `length ${length}`);
    assert.deepEqual(await readAuto(sealed), content, `length ${length}`);
  }
});

test("v1 files keep decrypting unchanged, with or without a file context", async () => {
  const legacy = concat(
    ...(await Promise.all(
      [0, 1, 2].map(
        async (index) =>
          new Uint8Array(
            await encryptFile(
              plain.slice(index * RS, (index + 1) * RS).buffer,
              key,
            ),
          ),
      ),
    )),
  );
  const expected = plain.subarray(0, 3 * RS);
  assert.deepEqual(await readStream(legacy), expected);
  assert.deepEqual(await readStream(legacy, null), expected);
  assert.deepEqual(await readAuto(legacy), expected);
  const preview = await readPreview(legacy, RS - 3, RS + 3);
  assert.deepEqual(preview.bytes, expected.subarray(RS - 3, RS + 3));
});

test("permuted records are refused", async () => {
  const swapped = concat(
    headerOf(encrypted),
    recordOf(encrypted, 1),
    recordOf(encrypted, 0),
    encrypted.slice(CONTENT_V2_HEADER_LENGTH + 2 * FULL),
  );
  await rejectsIntegrity(readStream(swapped));
  await rejectsIntegrity(readAuto(swapped));
  await rejectsIntegrity(readPreview(swapped, 0, 10).then((r) => r.bytes));
});

test("truncation at a record boundary is refused, even with a matching length", async () => {
  const cut = encrypted.slice(0, CONTENT_V2_HEADER_LENGTH + 2 * FULL);
  await rejectsIntegrity(readStream(cut));
  await rejectsIntegrity(readAuto(cut));
  await rejectsIntegrity(
    readPreview(cut, 2 * RS - 10, 2 * RS).then((r) => r.bytes),
  );
  await rejectsIntegrity(readStream(cut, fileA, encrypted.length));
});

test("an appended or duplicated record is refused", async () => {
  await rejectsIntegrity(readStream(concat(encrypted, recordOf(encrypted, 0))));
  await rejectsIntegrity(
    readStream(
      concat(
        headerOf(encrypted),
        recordOf(encrypted, 0),
        recordOf(encrypted, 0),
        encrypted.slice(CONTENT_V2_HEADER_LENGTH + 2 * FULL),
      ),
    ),
  );
});

test("records or whole files of another file or signing document are refused", async () => {
  const other = await encryptContentV2(key, fileB, plain);
  const mixed = concat(
    headerOf(encrypted),
    recordOf(encrypted, 0),
    recordOf(other, 1),
    encrypted.slice(CONTENT_V2_HEADER_LENGTH + 2 * FULL),
  );
  await rejectsIntegrity(readStream(mixed));
  await rejectsIntegrity(readStream(other, fileA));
  // The identity kind separates share files from signed results.
  await rejectsIntegrity(readStream(encrypted, signedA));
  const sameFileOtherNonce = await encryptContentV2(key, fileA, plain);
  await rejectsIntegrity(
    readStream(
      concat(
        headerOf(sameFileOtherNonce),
        encrypted.slice(CONTENT_V2_HEADER_LENGTH),
      ),
    ),
  );
});

test("corrupted headers, parameters and records are refused", async () => {
  for (const offset of [9, 12, 20, 31, CONTENT_V2_HEADER_LENGTH + 40]) {
    const corrupted = encrypted.slice();
    corrupted[offset] ^= 0x01;
    await rejectsIntegrity(readStream(corrupted));
  }
  const lastByte = encrypted.slice();
  lastByte[lastByte.length - 1] ^= 0x80;
  await rejectsIntegrity(readAuto(lastByte));
});

test("streams that end early or run longer are refused", async () => {
  await rejectsIntegrity(
    readStream(
      encrypted.slice(0, encrypted.length - 1),
      fileA,
      encrypted.length,
    ),
  );
  await rejectsIntegrity(
    readStream(concat(encrypted, Uint8Array.of(0)), fileA, encrypted.length),
  );
});

test("v2 is never read without its file and never as v1", async () => {
  await rejectsIntegrity(readStream(encrypted, null));
  await rejectsIntegrity(readAuto(encrypted, null));
  await rejectsIntegrity(readPreview(encrypted, 0, 10, null));
  await assert.rejects(
    readStream(encrypted.slice(CONTENT_V2_HEADER_LENGTH), null),
  );
});

test("re-encryption without the file identity refuses v2 content", async () => {
  const uploads = [];
  await rejectsIntegrity(
    reencryptStream({
      encryptedStream: streamOf(encrypted),
      oldKey: key,
      newKey: await generateEncryptionKey(),
      sourceChunkSize: RS,
      sourceChunkSizeIsExact: true,
      totalEncryptedSize: encrypted.length,
      targetChunkSize: RS,
      uploadChunk: async (chunk) => {
        uploads.push(chunk);
      },
    }),
  );
  assert.equal(uploads.length, 0);
});

test("integrity failures surface once, without unobserved rejections", async () => {
  const unobserved = [];
  const listener = (reason) => unobserved.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const corrupted = encrypted.slice();
    corrupted[CONTENT_V2_HEADER_LENGTH + 100] ^= 0x01;
    await rejectsIntegrity(readStream(corrupted));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(unobserved, []);
});

test("large content streams record by record", async () => {
  const large = bytes(48 * RS + 123_457, 9);
  const sealed = await encryptContentV2(key, fileA, large);
  let length = 0;
  let records = 0;
  for await (const part of decryptStream(
    streamOf(sealed, 16_384),
    key,
    RS,
    sealed.length,
    true,
    undefined,
    fileA,
  )) {
    assert.ok(part.length <= RS);
    length += part.length;
    records++;
  }
  assert.equal(length, large.length);
  assert.equal(records, 49);
});

test("record positions stay exact beyond 2^32 records", async () => {
  const records = 2 ** 33;
  const total =
    CONTENT_V2_HEADER_LENGTH + (records - 1) * FULL + CONTENT_V2_OVERHEAD + 5;
  const opened = await openContentV2(key, fileA, total, headerOf(encrypted));
  assert.equal(opened.records, records);
  assert.equal(opened.size, (records - 1) * RS + 5);
  assert.deepEqual(opened.recordRange(records - 1), [
    CONTENT_V2_HEADER_LENGTH + (records - 1) * FULL,
    total,
  ]);
});

test("freshness is not provided: an older complete version of the same file still reads", async () => {
  const older = await encryptContentV2(key, fileA, bytes(64, 1));
  assert.deepEqual(await readStream(older), bytes(64, 1));
});

async function reencryptTo(source, newKey, options = {}) {
  const uploads = [];
  const result = await reencryptStream({
    encryptedStream: streamOf(source),
    oldKey: options.oldKey ?? key,
    newKey,
    sourceChunkSize: RS,
    sourceChunkSizeIsExact: true,
    totalEncryptedSize: source.length,
    targetChunkSize: 2 * RS,
    targetRecordSize: RS,
    context: fileA,
    contentScheme: options.contentScheme,
    uploadChunk: async (chunk, index, total, recordSize, scheme) => {
      uploads.push({ chunk: new Uint8Array(chunk), index, total, scheme });
    },
  });
  return { result, rewritten: concat(...uploads.map((u) => u.chunk)), uploads };
}

test("the writer only produces the canonical encoding", async () => {
  const writer = await openContentV2Writer(key, fileA, RS + 3);
  assert.equal(writer.records, 2);
  await assert.rejects(writer.sealRecord(0, bytes(RS - 1, 1)));
  await assert.rejects(writer.sealRecord(1, bytes(4, 1)));
  await assert.rejects(writer.sealRecord(2, bytes(0, 1)));
  const empty = await openContentV2Writer(key, fileA, 0);
  assert.equal(empty.records, 1);
  const sealed = concat(empty.header, await empty.sealRecord(0, bytes(0, 1)));
  assert.equal(sealed.length, CONTENT_V2_HEADER_LENGTH + CONTENT_V2_OVERHEAD);
  assert.deepEqual(await readStream(sealed), bytes(0, 1));
});

test("a resumed writer adds records under the same file key", async () => {
  const content = bytes(3 * RS, 4);
  const first = await openContentV2Writer(key, fileA, content.length);
  const before = [
    await first.sealRecord(0, content.slice(0, RS)),
    await first.sealRecord(1, content.slice(RS, 2 * RS)),
  ];
  const resumed = await openContentV2Writer(
    key,
    fileA,
    content.length,
    contentV2Nonce(first.header),
  );
  assert.deepEqual(resumed.header, first.header);
  const assembled = concat(
    first.header,
    ...before,
    await resumed.sealRecord(2, content.slice(2 * RS)),
  );
  assert.deepEqual(await readStream(assembled), content);
  const fresh = await openContentV2Writer(key, fileA, content.length);
  await rejectsIntegrity(
    readStream(
      concat(
        first.header,
        ...before,
        await fresh.sealRecord(2, content.slice(2 * RS)),
      ),
    ),
  );
});

test("a signed result is bound to its signing document", async () => {
  const pdf = bytes(70_000, 6);
  const signed = await encryptContentV2(key, signedA, pdf);
  assert.deepEqual(await readAuto(signed, signedA), pdf);
  await rejectsIntegrity(readAuto(signed, fileA));
  await rejectsIntegrity(readAuto(signed, { signingDocumentId: "other" }));
});

test("a key with a v2 floor travels with its floor and keeps it", async () => {
  const floored = await generateEncryptionKey({ v2Floor: true });
  assert.equal(hasContentV2Floor(floored), true);
  const encoded = await exportKeyToBase64(floored);
  assert.equal(encoded.length, 44);
  const imported = await importKeyFromBase64(encoded);
  assert.equal(hasContentV2Floor(imported), true);
  assert.equal(await exportKeyToBase64(imported), encoded);

  const legacy = await importKeyFromBase64(await exportKeyToBase64(key));
  assert.equal(hasContentV2Floor(legacy), false);
  assert.equal((await exportKeyToBase64(key)).length, 43);

  const master = await generateEncryptionKey();
  const reopenedShare = await unwrapShareKey(
    await wrapShareKey(floored, master, "share-a"),
    master,
    "share-a",
  );
  assert.equal(hasContentV2Floor(reopenedShare), true);
  const wrappedTeam = await wrapReverseShareKey(floored, master);
  assert.equal(
    hasContentV2Floor(await unwrapReverseShareKey(wrappedTeam, master)),
    true,
  );
  // Builds without the floor refuse the 33-byte material instead of using it.
  const material = new Uint8Array(Buffer.from(encoded, "base64url"));
  assert.equal(material.length, 33);
  await assert.rejects(
    crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, true, [
      "decrypt",
    ]),
  );
  const unknownVersion = material.slice();
  unknownVersion[0] = 4;
  await assert.rejects(
    importKeyFromBase64(arrayBufferToBase64Url(unknownVersion.buffer)),
  );
});

test("a key with a v2 floor refuses v1 content, an empty object included", async () => {
  const floored = await generateEncryptionKey({ v2Floor: true });
  const v1 = new Uint8Array(
    await encryptFile(plain.slice(0, RS).buffer, floored),
  );
  await rejectsIntegrity(readStream(v1, fileA, v1.length, floored));
  await rejectsIntegrity(readAuto(v1, fileA, floored));
  await rejectsIntegrity(
    readPreview(v1, 0, 10, fileA, floored).then((r) => r.bytes),
  );
  await rejectsIntegrity(readStream(new Uint8Array(0), fileA, 0, floored));
  await rejectsIntegrity(readAuto(new Uint8Array(0), fileA, floored));
  const v2 = await encryptContentV2(floored, fileA, plain);
  assert.deepEqual(await readStream(v2, fileA, v2.length, floored), plain);
  assert.equal(contentWriteScheme(floored, false), 2);
  assert.equal(contentWriteScheme(key, false), 1);
  assert.equal(contentWriteScheme(key, true), 2);
});

test("re-encryption rewrites v2 as v2 and never back to v1", async () => {
  const newKey = await generateEncryptionKey();
  const { result, rewritten, uploads } = await reencryptTo(encrypted, newKey, {
    contentScheme: 1,
  });
  assert.equal(result.contentScheme, 2);
  assert.ok(uploads.every((upload) => upload.scheme === 2));
  assert.deepEqual(
    uploads.map((u) => u.index),
    [0, 1],
  );
  assert.deepEqual(
    await readStream(rewritten, fileA, rewritten.length, newKey),
    plain,
  );
  await rejectsIntegrity(readStream(rewritten, fileA, rewritten.length, key));
});

test("re-encryption writes v2 for a floored key or when asked, v1 otherwise", async () => {
  const legacy = concat(
    ...(await Promise.all(
      [0, 1, 2, 3].map(
        async (index) =>
          new Uint8Array(
            await encryptFile(
              plain.slice(index * RS, (index + 1) * RS).buffer,
              key,
            ),
          ),
      ),
    )),
  );
  const floored = await generateEncryptionKey({ v2Floor: true });
  const toFloor = await reencryptTo(legacy, floored, { contentScheme: 1 });
  assert.equal(toFloor.result.contentScheme, 2);
  assert.deepEqual(
    await readStream(
      toFloor.rewritten,
      fileA,
      toFloor.rewritten.length,
      floored,
    ),
    plain,
  );
  const plainKey = await generateEncryptionKey();
  const asked = await reencryptTo(legacy, plainKey, { contentScheme: 2 });
  assert.equal(asked.result.contentScheme, 2);
  assert.deepEqual(
    await readStream(asked.rewritten, fileA, asked.rewritten.length, plainKey),
    plain,
  );
  const kept = await reencryptTo(legacy, plainKey, { contentScheme: 1 });
  assert.equal(kept.result.contentScheme, 1);
  assert.deepEqual(
    await readStream(kept.rewritten, null, kept.rewritten.length, plainKey),
    plain,
  );
});

test("re-encryption keeps an empty v2 file as one empty final record", async () => {
  const empty = await encryptContentV2(key, fileA, new Uint8Array(0));
  const newKey = await generateEncryptionKey();
  const { rewritten, uploads } = await reencryptTo(empty, newKey);
  assert.equal(uploads.length, 1);
  assert.equal(
    rewritten.length,
    CONTENT_V2_HEADER_LENGTH + CONTENT_V2_OVERHEAD,
  );
  assert.deepEqual(
    await readStream(rewritten, fileA, rewritten.length, newKey),
    new Uint8Array(0),
  );
});

test("a historical empty v1 file becomes an authenticated empty v2 file during rotation", async () => {
  const newKey = await generateEncryptionKey({ v2Floor: true });
  const { rewritten, result, uploads } = await reencryptTo(
    new Uint8Array(0),
    newKey,
  );
  assert.equal(result.contentScheme, 2);
  assert.equal(uploads.length, 1);
  assert.equal(
    rewritten.length,
    CONTENT_V2_HEADER_LENGTH + CONTENT_V2_OVERHEAD,
  );
  assert.deepEqual(
    await readStream(rewritten, fileA, rewritten.length, newKey),
    new Uint8Array(0),
  );
});
