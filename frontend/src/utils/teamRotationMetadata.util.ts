import teamService from "../services/team.service";
import {
  decryptShareInfo,
  encryptShareInfo,
  encryptFileRequestInfo,
  openFileRequestInfo,
} from "./fileMetadata.util";

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
}
