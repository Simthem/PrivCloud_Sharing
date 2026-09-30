import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as released from "./fixtures/crypto.util.1.25.0.ts";
import {
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
import {
  LEGACY_ACCOUNT_KEY,
  SHARE_DEK_V1,
  SHARE_KEY_WRAP_ALGORITHM,
  ShareKeyUnavailableError,
  UnsupportedShareCryptoSchemeError,
  createShareDek,
  resolveOwnerShareKey,
  resolveShareCryptoScheme,
  rewrapShareKey,
} from "../src/utils/shareKey.util.ts";

const RECORD = 1_000_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function streamOf(bytes, fragment = 65_536) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + fragment));
      offset += fragment;
    },
  });
}

/** Same layout as the upload worker: independent 1 MB AES-GCM records. */
async function encryptRecords(plaintext, key) {
  const parts = [];
  for (let offset = 0; offset < plaintext.length; offset += RECORD) {
    parts.push(
      new Uint8Array(
        await encryptFile(plaintext.slice(offset, offset + RECORD).buffer, key),
      ),
    );
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function decryptWith(decryptStreamImpl, ciphertext, key) {
  const chunks = [];
  for await (const chunk of decryptStreamImpl(
    streamOf(ciphertext),
    key,
    RECORD,
    ciphertext.length,
    true,
  )) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function randomBytes(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 65_536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, length)));
  }
  return out;
}

function tamper(base64url, index) {
  const bytes = Buffer.from(base64url, "base64url");
  bytes[index] ^= 0x01;
  return bytes.toString("base64url");
}

async function newMaster() {
  return exportKeyToBase64(await generateEncryptionKey());
}

test("schemes: NULL and 1 are legacy, 2 is SHARE_DEK_V1, others refused", () => {
  assert.equal(resolveShareCryptoScheme(null), LEGACY_ACCOUNT_KEY);
  assert.equal(resolveShareCryptoScheme(undefined), LEGACY_ACCOUNT_KEY);
  assert.equal(resolveShareCryptoScheme(1), LEGACY_ACCOUNT_KEY);
  assert.equal(resolveShareCryptoScheme(2), SHARE_DEK_V1);
  assert.throws(
    () => resolveShareCryptoScheme(3),
    UnsupportedShareCryptoSchemeError,
  );
});

test("each share gets an independent random key and a 60-byte wrap", async () => {
  const master = await newMaster();
  const a = await createShareDek(master, "share-a");
  const b = await createShareDek(master, "share-b");
  assert.notEqual(a.encodedKey, b.encodedKey);
  assert.notEqual(a.encodedKey, master);
  assert.match(a.wrappedShareKey, /^[A-Za-z0-9_-]{80}$/);
  assert.equal(Buffer.from(a.wrappedShareKey, "base64url").length, 60);
  assert.equal(Buffer.from(a.encodedKey, "base64url").length, 32);
  assert.equal(a.wrappedShareKeyAlgorithm, SHARE_KEY_WRAP_ALGORITHM);
  // The wrap never contains K_share in clear.
  assert.equal(
    Buffer.from(a.wrappedShareKey, "base64url").includes(
      Buffer.from(a.encodedKey, "base64url"),
    ),
    false,
  );
  // Two wraps of the same key differ: a fresh IV is drawn each time.
  const masterKey = await importKeyFromBase64(master);
  const again = await wrapShareKey(a.key, masterKey, "share-a");
  assert.notEqual(again, a.wrappedShareKey);
});

test("owner unwraps K_share, legacy shares still resolve to K_master", async () => {
  const master = await newMaster();
  const dek = await createShareDek(master, "share-1");
  assert.equal(
    await resolveOwnerShareKey("share-1", master, {
      cryptoScheme: SHARE_DEK_V1,
      wrappedShareKey: dek.wrappedShareKey,
    }),
    dek.encodedKey,
  );
  for (const cryptoScheme of [null, undefined, LEGACY_ACCOUNT_KEY]) {
    assert.equal(
      await resolveOwnerShareKey("legacy", master, { cryptoScheme }),
      master,
    );
  }
  await assert.rejects(
    resolveOwnerShareKey("share-1", master, { cryptoScheme: SHARE_DEK_V1 }),
    ShareKeyUnavailableError,
  );
  await assert.rejects(
    resolveOwnerShareKey("share-1", master, { cryptoScheme: 7 }),
    UnsupportedShareCryptoSchemeError,
  );
});

test("reverse-share keys keep priority and their historical format", async () => {
  const master = await newMaster();
  const rsKey = await generateEncryptionKey();
  const wrapped = await wrapReverseShareKey(
    rsKey,
    await importKeyFromBase64(master),
  );
  assert.equal(
    await resolveOwnerShareKey("uploaded", master, {
      encryptedReverseShareKey: wrapped,
      cryptoScheme: null,
    }),
    await exportKeyToBase64(rsKey),
  );
  // K_rs and K_team wraps made by the released client still open.
  const legacyUnwrap = await released.unwrapReverseShareKey(
    wrapped,
    await released.importKeyFromBase64(master),
  );
  assert.equal(
    await released.exportKeyToBase64(legacyUnwrap),
    await exportKeyToBase64(rsKey),
  );
});

test("wrong key, other share, corrupted wrap, IV or tag are all refused", async () => {
  const master = await newMaster();
  const masterKey = await importKeyFromBase64(master);
  const other = await importKeyFromBase64(await newMaster());
  const { wrappedShareKey } = await createShareDek(master, "share-1");

  await assert.rejects(unwrapShareKey(wrappedShareKey, other, "share-1"));
  // The share id is authenticated: a wrap copied to another share fails.
  await assert.rejects(unwrapShareKey(wrappedShareKey, masterKey, "share-2"));
  await assert.rejects(unwrapShareKey(wrappedShareKey, masterKey, ""));
  // A plain K_rs-style unwrap (no additional data) fails too.
  await assert.rejects(unwrapReverseShareKey(wrappedShareKey, masterKey));
  for (const index of [0, 11, 12, 43, 44, 59]) {
    await assert.rejects(
      unwrapShareKey(tamper(wrappedShareKey, index), masterKey, "share-1"),
      undefined,
      `byte ${index}`,
    );
  }
  await assert.rejects(
    unwrapShareKey(wrappedShareKey.slice(0, 60), masterKey, "share-1"),
  );
});

test("released 1.25.0 recipients open a SHARE_DEK_V1 link unchanged", async () => {
  const master = await newMaster();
  const dek = await createShareDek(master, "share-1");
  const plaintext = randomBytes(2_600_123);
  const ciphertext = await encryptRecords(plaintext, dek.key);

  // Exactly what the released share page does with #key=<value>.
  const link = `https://share.example.test/s/share-1#key=${dek.encodedKey}`;
  const fragment = new URL(link).hash.match(/[#&]key=([A-Za-z0-9_-]+)/)[1];
  assert.equal(fragment, dek.encodedKey);
  const releasedKey = await released.importKeyFromBase64(fragment);
  const opened = await decryptWith(
    released.decryptStream,
    ciphertext,
    releasedKey,
  );
  assert.equal(sha256(opened), sha256(plaintext));

  // Small files take the single-block path of the released client.
  const small = randomBytes(4_321);
  const smallCipher = new Uint8Array(await encryptFile(small.buffer, dek.key));
  const smallOpened = await released.decryptFileAuto(
    smallCipher.buffer,
    releasedKey,
    RECORD,
  );
  assert.equal(sha256(new Uint8Array(smallOpened)), sha256(small));

  // The account key does not open it: a SHARE_DEK_V1 link never needs it.
  await assert.rejects(
    released.decryptFile(
      ciphertext.slice(0, RECORD + 28).buffer,
      await released.importKeyFromBase64(master),
    ),
  );
});

test("legacy shares keep working with the new client", async () => {
  const master = await newMaster();
  const releasedMaster = await released.importKeyFromBase64(master);
  const plaintext = randomBytes(1_500_000);
  const parts = [];
  for (let offset = 0; offset < plaintext.length; offset += RECORD) {
    parts.push(
      new Uint8Array(
        await released.encryptFile(
          plaintext.slice(offset, offset + RECORD).buffer,
          releasedMaster,
        ),
      ),
    );
  }
  const ciphertext = Buffer.concat(parts);
  const key = await importKeyFromBase64(
    await resolveOwnerShareKey("legacy", master, { cryptoScheme: null }),
  );
  const opened = await decryptWith(decryptStream, ciphertext, key);
  assert.equal(sha256(opened), sha256(plaintext));
});

test("rotation rewraps K_share: ciphertext and recipient link unchanged", async () => {
  const oldMaster = await newMaster();
  const newMasterKey = await newMaster();
  const dek = await createShareDek(oldMaster, "share-1");
  const plaintext = randomBytes(3_000_001);
  const ciphertext = await encryptRecords(plaintext, dek.key);
  const before = sha256(ciphertext);
  const link = `/s/share-1#key=${dek.encodedKey}`;

  const { wrappedShareKey, alreadyRewrapped } = await rewrapShareKey(
    dek.wrappedShareKey,
    oldMaster,
    newMasterKey,
    "share-1",
  );
  assert.equal(alreadyRewrapped, false);
  assert.notEqual(wrappedShareKey, dek.wrappedShareKey);

  // Nothing touched the stored bytes.
  assert.equal(sha256(ciphertext), before);
  // The owner now opens it with the new K_master only.
  assert.equal(
    await resolveOwnerShareKey("share-1", newMasterKey, {
      cryptoScheme: SHARE_DEK_V1,
      wrappedShareKey,
    }),
    dek.encodedKey,
  );
  await assert.rejects(
    resolveOwnerShareKey("share-1", oldMaster, {
      cryptoScheme: SHARE_DEK_V1,
      wrappedShareKey,
    }),
  );
  // The link handed out before the rotation still opens the files.
  const fromLink = link.split("#key=")[1];
  const opened = await decryptWith(
    released.decryptStream,
    ciphertext,
    await released.importKeyFromBase64(fromLink),
  );
  assert.equal(sha256(opened), sha256(plaintext));

  // Replaying the rotation (interrupted tab) is recognised, not re-applied.
  const replay = await rewrapShareKey(
    wrappedShareKey,
    oldMaster,
    newMasterKey,
    "share-1",
  );
  assert.equal(replay.alreadyRewrapped, true);
  assert.equal(replay.wrappedShareKey, wrappedShareKey);

  // A wrap that belongs to neither key is reported, never overwritten.
  await assert.rejects(
    rewrapShareKey(
      wrappedShareKey,
      await newMaster(),
      await newMaster(),
      "share-1",
    ),
  );
});

test("legacy rotation still re-encrypts K_master files as before", async () => {
  const oldMaster = await importKeyFromBase64(await newMaster());
  const newMasterKey = await importKeyFromBase64(await newMaster());
  const plaintext = randomBytes(2_100_000);
  const ciphertext = await encryptRecords(plaintext, oldMaster);
  const uploaded = [];
  await reencryptStream({
    encryptedStream: streamOf(ciphertext),
    oldKey: oldMaster,
    newKey: newMasterKey,
    sourceChunkSize: RECORD,
    sourceChunkSizeIsExact: true,
    totalEncryptedSize: ciphertext.length,
    targetChunkSize: RECORD,
    uploadChunk: async (chunk) => {
      uploaded.push(new Uint8Array(chunk));
    },
  });
  const rewritten = Buffer.concat(uploaded);
  assert.notEqual(sha256(rewritten), sha256(ciphertext));
  const opened = await decryptWith(decryptStream, rewritten, newMasterKey);
  assert.equal(sha256(opened), sha256(plaintext));
});

test("multi-file, empty and exact-record files round-trip with K_share", async () => {
  const master = await newMaster();
  const dek = await createShareDek(master, "multi");
  const key = await importKeyFromBase64(
    await resolveOwnerShareKey("multi", master, {
      cryptoScheme: SHARE_DEK_V1,
      wrappedShareKey: dek.wrappedShareKey,
    }),
  );
  for (const size of [1, RECORD - 1, RECORD, RECORD + 1, 3 * RECORD]) {
    const plaintext = randomBytes(size);
    const ciphertext = await encryptRecords(plaintext, dek.key);
    const opened = await decryptWith(decryptStream, ciphertext, key);
    assert.equal(sha256(opened), sha256(plaintext), `size ${size}`);
  }
  // A single flipped ciphertext bit is detected.
  const ciphertext = await encryptRecords(randomBytes(2 * RECORD), dek.key);
  ciphertext[RECORD + 100] ^= 0x01;
  await assert.rejects(decryptWith(decryptStream, ciphertext, key));
});

test("large file stream stays bounded and exact", async () => {
  const master = await newMaster();
  const dek = await createShareDek(master, "large");
  const plaintext = randomBytes(24 * RECORD + 777);
  const ciphertext = await encryptRecords(plaintext, dek.key);
  const opened = await decryptWith(
    released.decryptStream,
    ciphertext,
    await released.importKeyFromBase64(dek.encodedKey),
  );
  assert.equal(opened.length, plaintext.length);
  assert.equal(sha256(opened), sha256(plaintext));
});
