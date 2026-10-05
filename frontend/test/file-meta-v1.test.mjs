import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlToArrayBuffer,
  exportKeyToBase64,
  generateEncryptionKey,
} from "../src/utils/crypto.util.ts";
import {
  FILE_META_V1,
  InvalidFileMetadataError,
  decryptFileMetadata,
  decryptShareFileNames,
  encryptFileMetadata,
  normalizeFileMetadata,
  encryptedFilePlaceholderName,
  encryptShareInfo,
  decryptShareInfo,
  openShareInfo,
  openSharesWithKey,
  openFileName,
} from "../src/utils/fileMetadata.util.ts";
import { openSearchIndexNames } from "../src/utils/teamSearch.util.ts";

const SHARE = "share_A-1";
const FILE = "7352aeee-e01b-4dcc-a812-90d9e1647bed";
const OTHER_FILE = "0f1e2d3c-4b5a-4968-8776-655443322110";

// Same rule as the server check (backend file-metadata-scheme.ts).
function serverAccepts(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const plaintext = Math.floor((value.length * 3) / 4) - 28;
  return plaintext >= 64 && plaintext <= 4096 && plaintext % 64 === 0;
}

test("round trip keeps the name and the folder path", async () => {
  const key = await generateEncryptionKey();
  for (const [name, path] of [
    ["contrat.pdf", undefined],
    ["Relevé été 2026 ✓.xlsx", "Compta/2026/Relevé été 2026 ✓.xlsx"],
    ["日本語のファイル.txt", "書類/日本語のファイル.txt"],
    ["a".repeat(255), undefined],
  ]) {
    const encrypted = await encryptFileMetadata(key, SHARE, FILE, name, path);
    assert.ok(serverAccepts(encrypted), name);
    assert.doesNotMatch(encrypted, /contrat|Compta/);
    assert.deepEqual(
      await decryptFileMetadata(key, SHARE, FILE, encrypted),
      path ? { name, relativePath: path } : { name },
    );
  }
});

test("a file at the root stores no folder path", async () => {
  const key = await generateEncryptionKey();
  const encrypted = await encryptFileMetadata(
    key,
    SHARE,
    FILE,
    "a.txt",
    "a.txt",
  );
  assert.deepEqual(await decryptFileMetadata(key, SHARE, FILE, encrypted), {
    name: "a.txt",
  });
});

test("the share id and the file id are authenticated", async () => {
  const key = await generateEncryptionKey();
  const encrypted = await encryptFileMetadata(key, SHARE, FILE, "a.txt");
  await assert.rejects(decryptFileMetadata(key, SHARE, OTHER_FILE, encrypted));
  await assert.rejects(decryptFileMetadata(key, "share_B-2", FILE, encrypted));
  await assert.rejects(
    decryptFileMetadata(await generateEncryptionKey(), SHARE, FILE, encrypted),
  );
});

test("padding hides the length in steps of 64 bytes, IV is fresh", async () => {
  const key = await generateEncryptionKey();
  const short = await encryptFileMetadata(key, SHARE, FILE, "a.pdf");
  const longer = await encryptFileMetadata(
    key,
    SHARE,
    FILE,
    "a-much-longer-name.pdf",
  );
  assert.equal(short.length, longer.length);
  assert.equal(base64UrlToArrayBuffer(short).byteLength, 12 + 64 + 16);
  const again = await encryptFileMetadata(key, SHARE, FILE, "a.pdf");
  assert.notEqual(short, again);
  const big = await encryptFileMetadata(key, SHARE, FILE, "b".repeat(200));
  assert.equal((base64UrlToArrayBuffer(big).byteLength - 28) % 64, 0);
  assert.ok(base64UrlToArrayBuffer(big).byteLength > 12 + 64 + 16);
});

test("a folder path too long for one header keeps the file at the root", async () => {
  const key = await generateEncryptionKey();
  // 3665 characters, valid for the server, but 7265 bytes once in UTF-8.
  const segments = Array.from({ length: 60 }, () => "é".repeat(60));
  const path = [...segments, "x.txt"].join("/");
  assert.ok(path.length <= 4096);
  assert.ok(new TextEncoder().encode(path).byteLength > 4096);
  const encrypted = await encryptFileMetadata(key, SHARE, FILE, "x.txt", path);
  assert.ok(serverAccepts(encrypted));
  assert.ok(encrypted.length < 6000);
  assert.deepEqual(await decryptFileMetadata(key, SHARE, FILE, encrypted), {
    name: "x.txt",
  });
});

test("the server rules still apply to names it can no longer read", () => {
  for (const [name, path] of [
    ["", undefined],
    ["../x.pdf", undefined],
    ["a/b.pdf", undefined],
    ["a\\b.pdf", undefined],
    ["bad\u0001.pdf", undefined],
    ["n".repeat(256), undefined],
    ["b.pdf", "/abs/b.pdf"],
    ["b.pdf", "dir//b.pdf"],
    ["b.pdf", "dir/../b.pdf"],
    ["b.pdf", "C:/b.pdf"],
    ["b.pdf", "dir/c.pdf"],
    ["b.pdf", `${"d/".repeat(64)}b.pdf`],
  ]) {
    assert.throws(
      () => normalizeFileMetadata(name, path),
      InvalidFileMetadataError,
      `${name} ${path}`,
    );
  }
});

test("decrypted rows replace placeholders, never trust a bad name", async () => {
  const key = await generateEncryptionKey();
  const keyB64 = await exportKeyToBase64(key);
  const rows = [
    {
      id: FILE,
      name: encryptedFilePlaceholderName(FILE),
      relativePath: null,
      size: "1",
      metadataScheme: FILE_META_V1,
      encryptedMetadata: await encryptFileMetadata(
        key,
        SHARE,
        FILE,
        "zeta.pdf",
        "Dossier/zeta.pdf",
      ),
    },
    {
      id: OTHER_FILE,
      name: encryptedFilePlaceholderName(OTHER_FILE),
      relativePath: null,
      size: "2",
      metadataScheme: FILE_META_V1,
      // Moved from another file: the id no longer matches.
      encryptedMetadata: await encryptFileMetadata(
        key,
        SHARE,
        FILE,
        "evil.pdf",
      ),
    },
    { id: "plain-1", name: "alpha.txt", size: "3" },
  ];
  const opened = await decryptShareFileNames(SHARE, rows, keyB64);
  assert.deepEqual(
    opened.map((f) => [f.name, f.relativePath ?? null, !!f.metadataUnreadable]),
    [
      ["alpha.txt", null, false],
      [encryptedFilePlaceholderName(OTHER_FILE), null, true],
      ["zeta.pdf", "Dossier/zeta.pdf", false],
    ],
  );
  // Rows without encrypted names come back untouched.
  const plain = [{ id: "p", name: "p.txt" }];
  assert.equal(await decryptShareFileNames(SHARE, plain, keyB64), plain);
});

test("an unknown scheme is shown as unreadable, not as a name", async () => {
  const key = await exportKeyToBase64(await generateEncryptionKey());
  const [row] = await decryptShareFileNames(
    SHARE,
    [{ id: FILE, name: "leak.pdf", metadataScheme: 2, encryptedMetadata: "x" }],
    key,
  );
  assert.equal(row.metadataUnreadable, true);
  assert.equal(row.name, encryptedFilePlaceholderName(FILE));
});

test("share title and description round trip under the share key", async () => {
  const key = await generateEncryptionKey();
  const info = { name: "Bilan été 2026", description: "Pour le comptable" };
  const encrypted = await encryptShareInfo(key, SHARE, info);
  assert.ok(serverAccepts(encrypted));
  assert.doesNotMatch(encrypted, /Bilan|comptable/);
  assert.deepEqual(await decryptShareInfo(key, SHARE, encrypted), info);
  assert.deepEqual(
    await decryptShareInfo(
      key,
      SHARE,
      await encryptShareInfo(key, SHARE, { name: "Seul titre" }),
    ),
    { name: "Seul titre" },
  );
  // Nothing to hide: the share simply has no title.
  assert.equal(await encryptShareInfo(key, SHARE, {}), undefined);
  assert.equal(
    await encryptShareInfo(key, SHARE, { name: "", description: "" }),
    undefined,
  );
  await assert.rejects(
    encryptShareInfo(key, SHARE, { name: "x".repeat(91) }),
    InvalidFileMetadataError,
  );
});

test("a share title is bound to its share and to its key", async () => {
  const key = await generateEncryptionKey();
  const encrypted = await encryptShareInfo(key, SHARE, { name: "Contrat" });
  await assert.rejects(decryptShareInfo(key, "other-share", encrypted));
  await assert.rejects(
    decryptShareInfo(await generateEncryptionKey(), SHARE, encrypted),
  );
  // A title is never mistaken for a file name of the same share.
  await assert.rejects(decryptFileMetadata(key, SHARE, FILE, encrypted));
  assert.deepEqual(
    await openShareInfo({ id: SHARE, encryptedInfo: encrypted }, null),
    { infoUnreadable: true },
  );
  assert.deepEqual(
    await openShareInfo(
      { id: SHARE, encryptedInfo: encrypted },
      await generateEncryptionKey(),
    ),
    { infoUnreadable: true },
  );
  assert.deepEqual(
    await openShareInfo(
      { id: SHARE, name: "Lisible", description: null },
      null,
    ),
    { name: "Lisible" },
  );
});

test("Team folder shares open names, titles and descriptions with K_team", async () => {
  const teamKey = await generateEncryptionKey();
  const teamKeyB64 = await exportKeyToBase64(teamKey);
  const encryptedShare = {
    id: SHARE,
    name: null,
    description: null,
    encryptedInfo: await encryptShareInfo(teamKey, SHARE, {
      name: "RH",
      description: "Dossiers 2026",
    }),
    files: [
      {
        id: FILE,
        name: encryptedFilePlaceholderName(FILE),
        relativePath: null,
        metadataScheme: FILE_META_V1,
        encryptedMetadata: await encryptFileMetadata(
          teamKey,
          SHARE,
          FILE,
          "paie.pdf",
          "Paie/paie.pdf",
        ),
      },
    ],
  };
  const plainShare = {
    id: "plain",
    name: "Public",
    files: [{ id: OTHER_FILE, name: "lisible.txt" }],
  };
  const [opened, plain] = await openSharesWithKey(
    [encryptedShare, plainShare],
    teamKeyB64,
  );
  assert.equal(opened.name, "RH");
  assert.equal(opened.description, "Dossiers 2026");
  assert.equal(opened.files[0].name, "paie.pdf");
  assert.equal(opened.files[0].relativePath, "Paie/paie.pdf");
  assert.deepEqual(plain, plainShare);
  // Without encrypted rows the server list is returned as it is.
  const untouched = [plainShare];
  assert.equal(await openSharesWithKey(untouched, teamKeyB64), untouched);
});

test("search index and access rules show real names, never guesses", async () => {
  const teamKey = await generateEncryptionKey();
  const encryptedMetadata = await encryptFileMetadata(
    teamKey,
    SHARE,
    FILE,
    "budget.xlsx",
  );
  const index = {
    files: [
      {
        id: FILE,
        shareId: SHARE,
        shareName: null,
        shareEncryptedInfo: await encryptShareInfo(teamKey, SHARE, {
          name: "Finance",
        }),
        name: encryptedFilePlaceholderName(FILE),
        relativePath: null,
        metadataScheme: FILE_META_V1,
        encryptedMetadata,
      },
    ],
  };
  const opened = await openSearchIndexNames(
    index,
    await exportKeyToBase64(teamKey),
  );
  assert.equal(opened.files[0].name, "budget.xlsx");
  assert.equal(opened.files[0].shareName, "Finance");

  const rule = {
    shareId: SHARE,
    fileId: FILE,
    name: encryptedFilePlaceholderName(FILE),
    metadataScheme: FILE_META_V1,
    encryptedMetadata,
  };
  assert.deepEqual(await openFileName(rule, teamKey), { name: "budget.xlsx" });
  assert.deepEqual(await openFileName(rule, await generateEncryptionKey()), {
    name: encryptedFilePlaceholderName(FILE),
  });
});
