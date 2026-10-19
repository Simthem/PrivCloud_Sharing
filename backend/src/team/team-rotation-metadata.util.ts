import { ConflictException } from "@nestjs/common";

export type RotationMetadataUpdate = {
  kind: "SHARE" | "REQUEST" | "PROFILE" | "AUDIT" | "ACTIVITY";
  id: string;
  expectedEncryptedInfo: string;
  /** Empty only for ACTIVITY: the stored name is dropped. */
  encryptedInfo: string;
};

export function readRotationMetadataUpdates(value: string | null) {
  return (value ? JSON.parse(value) : []) as RotationMetadataUpdate[];
}

/** Require a replacement for every current ciphertext before retiring K_team. */
export function coveredRotationMetadata(
  rows: { id: string; encryptedInfo: string | null }[],
  kind: RotationMetadataUpdate["kind"],
  staged: RotationMetadataUpdate[],
): RotationMetadataUpdate[] {
  const byId = new Map(
    staged.filter((u) => u.kind === kind).map((u) => [u.id, u]),
  );
  return rows.map((row) => {
    const update = byId.get(row.id);
    if (!update || update.expectedEncryptedInfo !== row.encryptedInfo) {
      throw new ConflictException(
        "Encrypted team metadata must be rotated before completing the key rotation",
      );
    }
    return update;
  });
}
