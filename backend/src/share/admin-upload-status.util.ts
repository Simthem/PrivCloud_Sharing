import { isShareExpired } from "./share-expiration.util";

export type AdminUploadStatus = "READY" | "UNFINISHED" | "INACTIVE" | "EXPIRED";

/** Unfinished is a completion state, not proof that bytes are moving. */
export function getAdminUploadStatus(
  share: {
    uploadLocked: boolean;
    uploadLastActivityAt?: Date | null;
    expiration?: Date;
  },
  now = new Date(),
): AdminUploadStatus {
  if (share.expiration && isShareExpired(share.expiration, now))
    return "EXPIRED";
  if (share.uploadLocked) return "READY";
  const lastActivity = share.uploadLastActivityAt?.getTime();
  return Number.isFinite(lastActivity) &&
    now.getTime() - lastActivity! >= 45 * 60_000
    ? "INACTIVE"
    : "UNFINISHED";
}
