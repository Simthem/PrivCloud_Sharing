import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import {
  encryptedFilePlaceholderName,
  FILE_META_V1,
} from "src/file/file-metadata-scheme";
import {
  activityIdPrefixes,
  activityPlaceholders,
  activityRotationId,
  activityRotationRows,
  attachActivityEncryptedFiles,
  isCreationUploadDuplicate,
  rotateActivityMetadata,
  serializeActivityNames,
  storedActivityFiles,
} from "src/team/team-activity-names.util";
import { coveredRotationMetadata } from "src/team/team-rotation-metadata.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("team activity names");

// A well-formed FILE_META_V1 envelope: IV, one padded 64-byte block, tag.
const ciphertext = () => randomBytes(12 + 64 + 16).toString("base64url");

const encryptedFile = (folderId: string, shareId = randomUUID()) => {
  const fileId = randomUUID();
  return {
    fileId,
    shareId,
    folderId,
    name: encryptedFilePlaceholderName(fileId),
    metadataScheme: FILE_META_V1,
    encryptedMetadata: ciphertext(),
  };
};

const logged = (file: ReturnType<typeof encryptedFile>) => ({
  id: file.fileId,
  shareId: file.shareId,
  metadataScheme: file.metadataScheme,
  encryptedMetadata: file.encryptedMetadata,
});

testCase("finds every placeholder an event names, once", () => {
  const first = encryptedFilePlaceholderName(randomUUID());
  const second = encryptedFilePlaceholderName(randomUUID());
  assert.deepEqual(
    activityPlaceholders(`${first}, report.pdf, ${second}, ${first}`),
    [first, second],
  );
  assert.deepEqual(activityPlaceholders("report.pdf"), []);
  assert.deepEqual(activityPlaceholders("encrypted-file-short"), []);
  assert.deepEqual(activityPlaceholders(null), []);
});

testCase("looks placeholders up only for events tied to a folder", () => {
  const fileId = randomUUID();
  const placeholder = encryptedFilePlaceholderName(fileId);
  assert.deepEqual(
    activityIdPrefixes([
      { action: "UPLOAD", fileName: placeholder, folderId: randomUUID() },
      { action: "UPLOAD", fileName: placeholder, folderId: null },
    ]),
    [fileId.slice(0, 8)],
  );
});

testCase("attaches the encrypted names of the event's own folder", () => {
  const folderId = randomUUID();
  const otherFolderId = randomUUID();
  const mine = encryptedFile(folderId);
  const second = encryptedFile(folderId, mine.shareId);
  const elsewhere = encryptedFile(otherFolderId);
  const [upload, download, plain] = attachActivityEncryptedFiles(
    [
      {
        action: "UPLOAD",
        fileName: `${mine.name}, ${second.name}`,
        folderId,
      },
      // Same placeholder text, other folder: never the file of this folder.
      { action: "DOWNLOAD", fileName: mine.name, folderId: otherFolderId },
      { action: "DOWNLOAD", fileName: "report.pdf", folderId },
    ],
    [mine, second, elsewhere],
  );
  assert.deepEqual(
    upload.encryptedFiles?.map((file) => file.fileId),
    [mine.fileId, second.fileId],
  );
  assert.equal(
    upload.encryptedFiles?.some((file) => "folderId" in file),
    false,
  );
  assert.equal(download.encryptedFiles, undefined);
  assert.equal(plain.encryptedFiles, undefined);
});

testCase("keeps only encrypted names in the event metadata", () => {
  const folderId = randomUUID();
  const file = encryptedFile(folderId);
  const readable = {
    id: randomUUID(),
    shareId: file.shareId,
    metadataScheme: null,
    encryptedMetadata: null,
  };
  assert.equal(serializeActivityNames([readable]), undefined);
  const stored = storedActivityFiles(
    serializeActivityNames([logged(file), readable]),
  );
  assert.deepEqual([...stored.keys()], [file.name]);
  assert.deepEqual(stored.get(file.name), {
    fileId: file.fileId,
    shareId: file.shareId,
    metadataScheme: FILE_META_V1,
    encryptedMetadata: file.encryptedMetadata,
    name: file.name,
  });
});

testCase("a deleted file keeps the name stored with its event", () => {
  const folderId = randomUUID();
  const deleted = encryptedFile(folderId);
  const [download] = attachActivityEncryptedFiles(
    [
      {
        action: "DOWNLOAD",
        fileName: deleted.name,
        folderId,
        metadata: serializeActivityNames([logged(deleted)]),
      },
    ],
    [],
  );
  assert.equal(download.encryptedFiles?.[0].fileId, deleted.fileId);
});

testCase("an existing file wins over the name stored at logging", () => {
  const folderId = randomUUID();
  const current = encryptedFile(folderId);
  const atLogging = { ...current, encryptedMetadata: ciphertext() };
  const [upload] = attachActivityEncryptedFiles(
    [
      {
        action: "UPLOAD",
        fileName: current.name,
        folderId,
        metadata: serializeActivityNames([logged(atLogging)]),
      },
    ],
    [current],
  );
  assert.equal(
    upload.encryptedFiles?.[0].encryptedMetadata,
    current.encryptedMetadata,
  );
});

testCase("ignores metadata that is not a list of encrypted names", () => {
  for (const metadata of [
    "not json",
    "null",
    JSON.stringify({ encryptedFiles: "x" }),
    JSON.stringify({ encryptedFiles: [{ fileId: 1 }] }),
    JSON.stringify({
      encryptedFiles: [
        {
          fileId: randomUUID(),
          shareId: randomUUID(),
          metadataScheme: FILE_META_V1,
          encryptedMetadata: "not-an-envelope",
        },
      ],
    }),
    JSON.stringify({ seatId: randomUUID() }),
  ]) {
    assert.equal(storedActivityFiles(metadata).size, 0, metadata);
  }
});

testCase("hides only uploads logged without a size", () => {
  assert.equal(
    isCreationUploadDuplicate({ action: "UPLOAD", fileSize: null }),
    true,
  );
  assert.equal(isCreationUploadDuplicate({ action: "UPLOAD" }), true);
  assert.equal(
    isCreationUploadDuplicate({ action: "UPLOAD", fileSize: BigInt(0) }),
    false,
  );
  assert.equal(
    isCreationUploadDuplicate({ action: "DOWNLOAD", fileSize: null }),
    false,
  );
});

testCase("lists every stored name for the key rotation", () => {
  const folderId = randomUUID();
  const first = encryptedFile(folderId);
  const second = encryptedFile(folderId, first.shareId);
  const logId = randomUUID();
  const rows = activityRotationRows([
    {
      id: logId,
      metadata: serializeActivityNames([logged(first), logged(second)]) ?? null,
    },
    { id: randomUUID(), metadata: null },
    { id: randomUUID(), metadata: JSON.stringify({ seatId: randomUUID() }) },
  ]);
  assert.deepEqual(rows, [
    {
      id: activityRotationId(logId, first.fileId),
      shareId: first.shareId,
      fileId: first.fileId,
      encryptedInfo: first.encryptedMetadata,
    },
    {
      id: activityRotationId(logId, second.fileId),
      shareId: second.shareId,
      fileId: second.fileId,
      encryptedInfo: second.encryptedMetadata,
    },
  ]);
});

testCase("rotation replaces or drops stored names and keeps the rest", () => {
  const folderId = randomUUID();
  const kept = encryptedFile(folderId);
  const unreadable = encryptedFile(folderId, kept.shareId);
  const extra = randomUUID();
  const metadata = JSON.stringify({
    ...JSON.parse(
      serializeActivityNames([logged(kept), logged(unreadable)]) as string,
    ),
    extra,
  });
  const rotated = ciphertext();
  const result = JSON.parse(
    rotateActivityMetadata(
      metadata,
      new Map([
        [kept.fileId, rotated],
        [unreadable.fileId, ""],
      ]),
    ),
  );
  assert.equal(result.extra, extra);
  assert.deepEqual(
    result.encryptedFiles.map(
      (file: { fileId: string; encryptedMetadata: string }) => [
        file.fileId,
        file.encryptedMetadata,
      ],
    ),
    [[kept.fileId, rotated]],
  );
  const allDropped = JSON.parse(
    rotateActivityMetadata(
      serializeActivityNames([logged(kept)]) as string,
      new Map([[kept.fileId, ""]]),
    ),
  );
  assert.equal("encryptedFiles" in allDropped, false);
});

testCase("a rotation cannot complete with a stored name left behind", () => {
  const folderId = randomUUID();
  const file = encryptedFile(folderId);
  const rows = activityRotationRows([
    {
      id: randomUUID(),
      metadata: serializeActivityNames([logged(file)]) ?? null,
    },
  ]);
  assert.throws(
    () => coveredRotationMetadata(rows, "ACTIVITY", []),
    ConflictException,
  );
  assert.throws(
    () =>
      coveredRotationMetadata(rows, "ACTIVITY", [
        {
          kind: "ACTIVITY",
          id: rows[0].id,
          expectedEncryptedInfo: ciphertext(),
          encryptedInfo: ciphertext(),
        },
      ]),
    ConflictException,
  );
  const update = {
    kind: "ACTIVITY" as const,
    id: rows[0].id,
    expectedEncryptedInfo: rows[0].encryptedInfo,
    encryptedInfo: ciphertext(),
  };
  assert.deepEqual(coveredRotationMetadata(rows, "ACTIVITY", [update]), [
    update,
  ]);
});

void run();
