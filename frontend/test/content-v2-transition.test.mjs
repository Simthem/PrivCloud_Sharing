import { CONTENT_V2_MAGIC } from "../src/utils/contentV2.util.ts";
import {
  setSigningResultV2Floor,
  hasSigningResultV2Floor,
} from "../src/utils/contentV2.util.ts";
import {
  contentV2FileId,
  contentV2ShareId,
} from "../src/utils/shareContentContext.util.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptFileAuto,
  encryptFile,
  exportKeyToBase64,
  generateEncryptionKey,
  importKeyFromBase64,
  unwrapReverseShareKey,
  wrapReverseShareKey,
} from "../src/utils/crypto.util.ts";
import {
  ContentIntegrityError,
  contentWriteScheme,
  encryptContentV2,
  hasContentV2Floor,
} from "../src/utils/contentV2.util.ts";
import {
  decryptFileMetadata,
  decryptShareFileNames,
  encryptFileMetadata,
} from "../src/utils/fileMetadata.util.ts";
import {
  createShareDek,
  resolveOwnerShareKey,
} from "../src/utils/shareKey.util.ts";
import {
  applyContentPolicy,
  contentPolicy,
  noteContentV2Required,
} from "../src/utils/contentPolicy.util.ts";

const plain = new Uint8Array([1, 2, 3, 4]);
const read = (bytes, key, fileId) =>
  decryptFileAuto(bytes.buffer, key, 1_000_000, { fileId });

test("activation creates floored keys without a second operator switch", () => {
  applyContentPolicy([{ key: "share.contentV2Writes", value: "true" }]);
  assert.deepEqual(contentPolicy(), { v2Writes: true, v2Floor: true });
  applyContentPolicy([]);
});

test("new personal shares use a separate floored key without rotating the master key", async () => {
  const master = await exportKeyToBase64(await generateEncryptionKey());
  const dek = await createShareDek(master, "personal", { v2Floor: true });
  assert.notEqual(dek.encodedKey, master);
  const resolved = await resolveOwnerShareKey("personal", master, {
    cryptoScheme: 2,
    wrappedShareKey: dek.wrappedShareKey,
  });
  assert.equal(resolved, dek.encodedKey);
  const reopened = await importKeyFromBase64(resolved);
  assert.equal(hasContentV2Floor(reopened), true);
  const stored = await encryptContentV2(reopened, { fileId: "new" }, plain);
  assert.deepEqual(new Uint8Array(await read(stored, reopened, "new")), plain);
  await assert.rejects(
    read(new Uint8Array(0), reopened, "new"),
    ContentIntegrityError,
  );
  assert.equal(master, await resolveOwnerShareKey("legacy", master, {}));
});

test("historical account, share, reverse and team keys keep v1 while writing new file subkeys in v2", async () => {
  for (const kind of ["account", "share", "reverse", "team"]) {
    const key = await generateEncryptionKey();
    const before = await exportKeyToBase64(key);
    const old = new Uint8Array(await encryptFile(plain.buffer, key));
    const next = await encryptContentV2(key, { fileId: `${kind}-new` }, plain);
    const descriptor = await encryptFileMetadata(
      key,
      kind,
      `${kind}-new`,
      "new.txt",
      undefined,
      2,
    );
    await decryptFileMetadata(key, kind, `${kind}-new`, descriptor);
    assert.equal(contentWriteScheme(key, true), 2);
    assert.deepEqual(
      new Uint8Array(await read(old, key, `${kind}-old`)),
      plain,
    );
    assert.deepEqual(
      new Uint8Array(await read(next, key, `${kind}-new`)),
      plain,
    );
    assert.equal(await exportKeyToBase64(key), before);
    await assert.rejects(
      read(old, await importKeyFromBase64(before), `${kind}-new`),
      ContentIntegrityError,
    );
  }
});

test("an existing reverse link and owner envelope survive mixed-format deposits", async () => {
  const master = await generateEncryptionKey();
  const rs = await generateEncryptionKey();
  const fragment = await exportKeyToBase64(rs);
  const wrapped = await wrapReverseShareKey(rs, master);
  const sender = await importKeyFromBase64(fragment);
  const owner = await unwrapReverseShareKey(wrapped, master);
  const v1 = new Uint8Array(await encryptFile(plain.buffer, sender));
  const v2 = await encryptContentV2(sender, { fileId: "deposit-new" }, plain);
  assert.deepEqual(new Uint8Array(await read(v1, owner, "deposit-old")), plain);
  assert.deepEqual(new Uint8Array(await read(v2, owner, "deposit-new")), plain);
  assert.equal(await exportKeyToBase64(owner), fragment);
});

test("authenticated per-file policy survives key imports and refuses simultaneous v1 and descriptor substitution", async () => {
  const key = await generateEncryptionKey();
  const encoded = await exportKeyToBase64(key);
  const descriptor = await encryptFileMetadata(
    key,
    "share",
    "file-new",
    "invoice.pdf",
    undefined,
    2,
  );
  const legacyDescriptor = await encryptFileMetadata(
    key,
    "share",
    "file-old",
    "old.pdf",
  );
  await assert.rejects(
    decryptFileMetadata(key, "share", "file-new", legacyDescriptor),
  );
  await assert.rejects(
    decryptFileMetadata(key, "other-share", "file-new", descriptor),
  );
  await decryptFileMetadata(key, "share", "file-new", descriptor);
  const imported = await importKeyFromBase64(encoded);
  const legacy = new Uint8Array(await encryptFile(plain.buffer, imported));
  await assert.rejects(
    read(legacy, imported, "file-new"),
    ContentIntegrityError,
  );
  await assert.rejects(
    read(new Uint8Array(0), imported, "file-new"),
    ContentIntegrityError,
  );
  assert.deepEqual(
    new Uint8Array(await read(legacy, imported, "file-old")),
    plain,
  );
});

test("missing or substituted descriptions block content under a new key and recover after valid metadata arrives", async () => {
  const key = await generateEncryptionKey({ v2Floor: true });
  const descriptor = await encryptFileMetadata(
    key,
    "share",
    "protected",
    "document.txt",
  );
  const stored = await encryptContentV2(key, { fileId: "protected" }, plain);
  const rows = await decryptShareFileNames(
    "share",
    [{ id: "protected", name: "fake" }],
    key,
  );
  assert.equal(rows[0].metadataUnreadable, true);
  await assert.rejects(read(stored, key, "protected"), ContentIntegrityError);
  const recovered = await decryptShareFileNames(
    "share",
    [
      {
        id: "protected",
        name: "fake",
        metadataScheme: 1,
        encryptedMetadata: descriptor,
      },
    ],
    await exportKeyToBase64(key),
  );
  assert.equal(recovered[0].name, "document.txt");
  assert.deepEqual(new Uint8Array(await read(stored, key, "protected")), plain);
});

test("a v2-required response upgrades new key policy for stale public configuration", () => {
  noteContentV2Required();
  applyContentPolicy([{ key: "share.contentV2Writes", value: "false" }]);
  assert.deepEqual(contentPolicy(), { v2Writes: true, v2Floor: true });
});

test("the current bundle never accepts a server request to create new v1 contexts", () => {
  applyContentPolicy([
    { key: "share.contentV2Writes", value: "false" },
    { key: "share.contentV2Floor", value: "false" },
  ]);
  assert.deepEqual(contentPolicy(), { v2Writes: true, v2Floor: true });
});

test("a new file in a historical share refuses v1 on a fresh reader before any descriptor is opened", async () => {
  const key = await generateEncryptionKey();
  const fileId = contentV2FileId(crypto.randomUUID());
  const old = new Uint8Array(await encryptFile(plain.buffer, key));
  await assert.rejects(read(old, key, fileId), ContentIntegrityError);
  await assert.rejects(
    read(new Uint8Array(0), key, fileId),
    ContentIntegrityError,
  );
  const v2 = await encryptContentV2(key, { fileId }, plain);
  assert.deepEqual(new Uint8Array(await read(v2, key, fileId)), plain);
  const legacyId = fileId.slice(0, 14) + "4" + fileId.slice(15);
  await assert.rejects(read(v2, key, legacyId), ContentIntegrityError);
  assert.deepEqual(new Uint8Array(await read(old, key, legacyId)), plain);
});

test("a new share never falls back to the account key when its envelope is suppressed", async () => {
  const master = await exportKeyToBase64(await generateEncryptionKey());
  const shareId = contentV2ShareId("new-share");
  await assert.rejects(
    resolveOwnerShareKey(shareId, master, {}),
    /wrapped key.*required/,
  );
  assert.equal(await resolveOwnerShareKey("historic", master, {}), master);
});

test("new deposits enforce v2 without replacing the historical reverse link or its wrapped key", async () => {
  const master = await generateEncryptionKey();
  const root = await generateEncryptionKey();
  const linkKey = await exportKeyToBase64(root);
  const envelope = await wrapReverseShareKey(root, master);
  const encodedMaster = await exportKeyToBase64(master);
  const legacy = await resolveOwnerShareKey("historic-child", encodedMaster, {
    encryptedReverseShareKey: envelope,
  });
  const adopted = await resolveOwnerShareKey(
    contentV2ShareId("new-child"),
    encodedMaster,
    { encryptedReverseShareKey: envelope },
  );
  assert.equal(legacy, linkKey);
  assert.equal(hasContentV2Floor(await importKeyFromBase64(adopted)), true);
  const old = new Uint8Array(await encryptFile(plain.buffer, root));
  await assert.rejects(
    read(old, await importKeyFromBase64(adopted), "new"),
    ContentIntegrityError,
  );
  assert.deepEqual(
    new Uint8Array(await read(old, await importKeyFromBase64(legacy), "old")),
    plain,
  );
  assert.equal(
    await exportKeyToBase64(await unwrapReverseShareKey(envelope, master)),
    linkKey,
  );
});

test("a new signature capability reads a v1 source but refuses v1 signed results", async () => {
  const root = await generateEncryptionKey();
  const legacy = new Uint8Array(await encryptFile(plain.buffer, root));
  const capability = await importKeyFromBase64(
    await exportKeyToBase64(setSigningResultV2Floor(root)),
  );
  assert.equal(hasSigningResultV2Floor(capability), true);
  assert.equal(hasContentV2Floor(capability), false);
  assert.equal(contentWriteScheme(capability, false), 2);
  await assert.rejects(
    decryptFileAuto(legacy.buffer, capability, 1_000_000),
    ContentIntegrityError,
  );
  assert.deepEqual(
    new Uint8Array(await read(legacy, capability, "historic-source")),
    plain,
  );
  await assert.rejects(
    decryptFileAuto(legacy.buffer, capability, 1_000_000, {
      signingDocumentId: "result",
    }),
    ContentIntegrityError,
  );
  await assert.rejects(
    decryptFileAuto(new ArrayBuffer(0), capability, 1_000_000, {
      signingDocumentId: "result",
    }),
    ContentIntegrityError,
  );
  const signed = await encryptContentV2(
    capability,
    { signingDocumentId: "result" },
    plain,
  );
  assert.deepEqual(
    new Uint8Array(
      await decryptFileAuto(signed.buffer, capability, 1_000_000, {
        signingDocumentId: "result",
      }),
    ),
    plain,
  );
  const master = await generateEncryptionKey();
  const restored = await unwrapReverseShareKey(
    await wrapReverseShareKey(capability, master),
    master,
  );
  assert.equal(hasSigningResultV2Floor(restored), true);
  assert.equal(hasContentV2Floor(restored), false);
});

test("a short object bearing the v2 magic is never retried as v1", async () => {
  const key = await generateEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  iv.set(CONTENT_V2_MAGIC);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  const stored = new Uint8Array(iv.length + encrypted.length);
  stored.set(iv);
  stored.set(encrypted, iv.length);
  await assert.rejects(read(stored, key, "legacy"), ContentIntegrityError);
});
