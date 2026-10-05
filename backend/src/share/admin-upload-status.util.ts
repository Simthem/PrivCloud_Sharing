export type AdminUploadStatus = "READY" | "UNFINISHED" | "INACTIVE";

/** Unfinished is a completion state, not proof that bytes are moving. */
export function getAdminUploadStatus(
  share: { uploadLocked: boolean; uploadLastActivityAt?: Date | null },
  now = new Date(),
): AdminUploadStatus {
  if (share.uploadLocked) return "READY";
  const lastActivity = share.uploadLastActivityAt?.getTime();
  return Number.isFinite(lastActivity) &&
    now.getTime() - lastActivity! >= 45 * 60_000
    ? "INACTIVE"
    : "UNFINISHED";
}
