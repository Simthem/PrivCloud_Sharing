import { ConflictException } from "@nestjs/common";
import type { PrismaService } from "src/prisma/prisma.service";

export const UPLOAD_ACTIVITY_TOUCH_INTERVAL_MS = 60 * 1000;
export const ABANDONED_UPLOAD_TIMEOUT_MS = 45 * 60 * 1000;
export const ABANDONED_UPLOAD_CLEANUP_CRON = "*/5 * * * *";

type UploadActivityShare = {
  id: string;
  uploadLocked: boolean;
  uploadLastActivityAt?: Date;
  uploadCleanupStartedAt?: Date | null;
};

export const getAbandonedUploadCutoff = (now = new Date()) =>
  new Date(now.getTime() - ABANDONED_UPLOAD_TIMEOUT_MS);

/**
 * Persist upload activity at most once a minute. The caller has already
 * loaded the share, so hot chunk paths avoid another read.
 */
export async function touchShareUploadActivity(
  prisma: PrismaService,
  share: UploadActivityShare,
  now = new Date(),
): Promise<void> {
  if (share.uploadCleanupStartedAt) {
    throw new ConflictException("Upload cleanup is already in progress");
  }
  if (share.uploadLocked || !share.uploadLastActivityAt) return;

  const staleBefore = new Date(
    now.getTime() - UPLOAD_ACTIVITY_TOUCH_INTERVAL_MS,
  );
  if (share.uploadLastActivityAt > staleBefore) return;

  const { count } = await prisma.share.updateMany({
    where: {
      id: share.id,
      uploadLocked: false,
      uploadCleanupStartedAt: null,
      uploadLastActivityAt: { lte: staleBefore },
    },
    data: { uploadLastActivityAt: now },
  });

  if (count > 0) return;

  // Another heartbeat may have won the race, which is harmless. A cleanup
  // claim, completion or deletion is not: the caller must stop before writing
  // any more bytes to storage.
  const current = await prisma.share.findUnique({
    where: { id: share.id },
    select: {
      uploadLocked: true,
      uploadCleanupStartedAt: true,
    },
  });
  if (!current || current.uploadLocked || current.uploadCleanupStartedAt) {
    throw new ConflictException("Upload is no longer writable");
  }
}
