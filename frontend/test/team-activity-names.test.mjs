import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  exportKeyToBase64,
  generateEncryptionKey,
} from "../src/utils/crypto.util.ts";
import {
  FILE_META_V1,
  encryptFileMetadata,
  encryptedFilePlaceholderName,
} from "../src/utils/fileMetadata.util.ts";
import { openActivityNames } from "../src/utils/teamActivityNames.util.ts";
import { openSearchIndexNames } from "../src/utils/teamSearch.util.ts";

async function encryptedFile(teamKey, name) {
  const shareId = randomUUID();
  const fileId = randomUUID();
  return {
    shareId,
    fileId,
    name: encryptedFilePlaceholderName(fileId),
    metadataScheme: FILE_META_V1,
    encryptedMetadata: await encryptFileMetadata(
      teamKey,
      shareId,
      fileId,
      name,
    ),
  };
}

test("activity shows the real names of a multi-file upload", async () => {
  const teamKey = await generateEncryptionKey();
  const first = await encryptedFile(teamKey, "budget, 2026.xlsx");
  const second = await encryptedFile(teamKey, "contrat.pdf");
  const [upload, plain] = await openActivityNames(
    [
      {
        action: "UPLOAD",
        fileName: `${first.name}, notes.txt, ${second.name}`,
        encryptedFiles: [first, second],
      },
      { action: "DOWNLOAD", fileName: "notes.txt" },
    ],
    teamKey,
  );
  assert.equal(upload.fileName, "budget, 2026.xlsx, notes.txt, contrat.pdf");
  assert.equal(plain.fileName, "notes.txt");
});

test("a name that does not open keeps its placeholder", async () => {
  const file = await encryptedFile(await generateEncryptionKey(), "rh.pdf");
  const [download] = await openActivityNames(
    [{ action: "DOWNLOAD", fileName: file.name, encryptedFiles: [file] }],
    await generateEncryptionKey(),
  );
  assert.equal(download.fileName, file.name);
});

test("the search opens activity names even without encrypted files", async () => {
  const teamKey = await generateEncryptionKey();
  const file = await encryptedFile(teamKey, "facture.pdf");
  const opened = await openSearchIndexNames(
    {
      files: [],
      activity: [
        { action: "UPLOAD", fileName: file.name, encryptedFiles: [file] },
      ],
    },
    await exportKeyToBase64(teamKey),
  );
  assert.equal(opened.activity[0].fileName, "facture.pdf");
});

test("key rotation re-encrypts every stored activity name", async () => {
  const { default: teamService } =
    await import("../src/services/team.service.ts");
  const { rotateTeamMetadata } =
    await import("../src/utils/teamRotationMetadata.util.ts");
  const { decryptFileMetadata } =
    await import("../src/utils/fileMetadata.util.ts");
  const oldKey = await generateEncryptionKey();
  const newKey = await generateEncryptionKey();
  const underOld = await encryptedFile(oldKey, "bilan annuel.pdf");
  const underNew = await encryptedFile(newKey, "rotation en cours.pdf");
  const unreadable = await encryptedFile(
    await generateEncryptionKey(),
    "inconnu.pdf",
  );
  // More than one batch of 100.
  const many = await Promise.all(
    Array.from({ length: 101 }, (_, i) => encryptedFile(oldKey, `n${i}.txt`)),
  );
  const logId = randomUUID();
  const row = (file) => ({
    id: `${logId}:${file.fileId}`,
    shareId: file.shareId,
    fileId: file.fileId,
    encryptedInfo: file.encryptedMetadata,
  });
  const originalGet = teamService.getKeyRotationMetadata;
  const originalStage = teamService.stageKeyRotationActivityNames;
  const batches = [];
  teamService.getKeyRotationMetadata = async () => ({
    shares: [],
    requests: [],
    activity: [underOld, underNew, unreadable, ...many].map(row),
  });
  teamService.stageKeyRotationActivityNames = async (_t, _r, entries) => {
    batches.push(entries);
  };
  try {
    await rotateTeamMetadata("team-1", "rotation-1", oldKey, newKey);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [100, 4],
    );
    const staged = new Map(batches.flat().map((e) => [e.fileId, e]));
    assert.equal(staged.size, 104);
    for (const entry of staged.values()) assert.equal(entry.logId, logId);
    assert.doesNotMatch(JSON.stringify(batches), /bilan|rotation en|inconnu/);
    const opened = staged.get(underOld.fileId);
    assert.equal(opened.expectedEncryptedMetadata, underOld.encryptedMetadata);
    assert.deepEqual(
      await decryptFileMetadata(
        newKey,
        underOld.shareId,
        underOld.fileId,
        opened.encryptedMetadata,
      ),
      { name: "bilan annuel.pdf" },
    );
    assert.equal(
      staged.get(underNew.fileId).encryptedMetadata,
      underNew.encryptedMetadata,
    );
    assert.equal(staged.get(unreadable.fileId).encryptedMetadata, "");
  } finally {
    teamService.getKeyRotationMetadata = originalGet;
    teamService.stageKeyRotationActivityNames = originalStage;
  }
});
