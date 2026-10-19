import teamService from "../services/team.service";
import {
  decryptFileMetadata,
  decryptShareInfo,
  encryptFileMetadata,
  encryptShareInfo,
  encryptFileRequestInfo,
  encryptTeamProfile,
  openFileRequestInfo,
  openTeamProfile,
} from "./fileMetadata.util";
import { unwrapAuditKey, wrapAuditKey } from "./teamAudit.util";

/** Stage ciphertexts only. The backend commits them atomically with the new K_team. */
export async function rotateTeamMetadata(
  teamId: string,
  rotationId: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
  signal?: AbortSignal,
) {
  const metadata = await teamService.getKeyRotationMetadata(teamId);
  for (const kind of ["SHARE", "REQUEST"] as const) {
    const rows = kind === "SHARE" ? metadata.shares : metadata.requests;
    for (const row of rows) {
      signal?.throwIfAborted();
      let encryptedInfo: string | undefined;
      if (kind === "SHARE") {
        encryptedInfo = await encryptShareInfo(
          newKey,
          row.id,
          await decryptShareInfo(oldKey, row.id, row.encryptedInfo),
        );
      } else {
        const info = await openFileRequestInfo({ ...row, subject: "" }, oldKey);
        if (!info)
          throw new Error(
            "Unable to open encrypted file request for key rotation",
          );
        encryptedInfo = await encryptFileRequestInfo(newKey, row.id, info);
      }
      if (!encryptedInfo)
        throw new Error("Unable to rotate encrypted team metadata");
      await teamService.stageKeyRotationMetadata(teamId, rotationId, {
        kind,
        id: row.id,
        expectedEncryptedInfo: row.encryptedInfo,
        encryptedInfo,
      });
    }
  }
  // Company details used in contractor watermarks.
  for (const row of metadata.profile ?? []) {
    signal?.throwIfAborted();
    const profile = await openTeamProfile(oldKey, teamId, row.encryptedInfo);
    if (!profile)
      throw new Error("Unable to open the team profile for key rotation");
    await teamService.stageKeyRotationMetadata(teamId, rotationId, {
      kind: "PROFILE",
      id: row.id,
      expectedEncryptedInfo: row.encryptedInfo,
      encryptedInfo: await encryptTeamProfile(newKey, teamId, profile),
    });
  }
  await rotateActivityNames(
    teamId,
    rotationId,
    metadata.activity ?? [],
    oldKey,
    newKey,
    signal,
  );
  // Audit key of contractor copies: re-wrapped, never changed, so that the
  // marks issued before this rotation stay detectable.
  for (const row of metadata.auditKey ?? []) {
    signal?.throwIfAborted();
    const raw = await unwrapAuditKey(oldKey, teamId, row.encryptedInfo);
    try {
      await teamService.stageKeyRotationMetadata(teamId, rotationId, {
        kind: "AUDIT",
        id: row.id,
        expectedEncryptedInfo: row.encryptedInfo,
        encryptedInfo: await wrapAuditKey(newKey, teamId, raw),
      });
    } finally {
      raw.fill(0);
    }
  }
}

const ACTIVITY_BATCH = 100;

/**
 * File names stored in activity events, so that the activity still shows
 * them after the files are deleted. Each is re-encrypted with the new key. A
 * name already under the new key, logged during this rotation, is staged as it
 * is. One that opens with neither key is unreadable for everyone: it is
 * dropped rather than left to block this rotation and every later one.
 */
async function rotateActivityNames(
  teamId: string,
  rotationId: string,
  rows: {
    id: string;
    shareId: string;
    fileId: string;
    encryptedInfo: string;
  }[],
  oldKey: CryptoKey,
  newKey: CryptoKey,
  signal?: AbortSignal,
) {
  for (let start = 0; start < rows.length; start += ACTIVITY_BATCH) {
    const entries = [];
    for (const row of rows.slice(start, start + ACTIVITY_BATCH)) {
      signal?.throwIfAborted();
      entries.push({
        logId: row.id.slice(0, row.id.indexOf(":")),
        fileId: row.fileId,
        expectedEncryptedMetadata: row.encryptedInfo,
        encryptedMetadata: await rotatedActivityName(row, oldKey, newKey),
      });
    }
    await teamService.stageKeyRotationActivityNames(
      teamId,
      rotationId,
      entries,
    );
  }
}

async function rotatedActivityName(
  row: { shareId: string; fileId: string; encryptedInfo: string },
  oldKey: CryptoKey,
  newKey: CryptoKey,
): Promise<string> {
  const opensWith = (key: CryptoKey) =>
    decryptFileMetadata(key, row.shareId, row.fileId, row.encryptedInfo).catch(
      () => null,
    );
  const metadata = await opensWith(oldKey);
  if (metadata) {
    return encryptFileMetadata(
      newKey,
      row.shareId,
      row.fileId,
      metadata.name,
      metadata.relativePath,
    );
  }
  return (await opensWith(newKey)) ? row.encryptedInfo : "";
}
