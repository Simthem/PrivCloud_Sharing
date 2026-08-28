import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import * as fs from "fs";
import moment from "moment";
import { ConfigService } from "src/config/config.service";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import { ReverseShareService } from "src/reverseShare/reverseShare.service";
import { TeamAuditService } from "src/team/team-audit.service";
import { TeamService } from "src/team/team.service";
import {
  ABANDONED_UPLOAD_CLEANUP_CRON,
  getAbandonedUploadCutoff,
} from "src/share/upload-activity.util";
import { NEVER_EXPIRES_CUTOFF_DATE } from "src/utils/date.util";
import { SHARE_DIRECTORY } from "../constants";

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly runningJobs = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private reverseShareService: ReverseShareService,
    private fileService: FileService,
    private teamAuditService: TeamAuditService,
    private teamService: TeamService,
    private config: ConfigService,
  ) {}

  private async runExclusive(jobName: string, job: () => Promise<void>) {
    const lockName = [
      "deleteExpiredShares",
      "deleteExpiredReverseShares",
      "deleteUnfinishedShares",
    ].includes(jobName)
      ? "share-cleanup"
      : jobName;

    if (this.runningJobs.has(lockName)) {
      this.logger.debug(
        `Skipped ${jobName}: the previous run is still active`,
      );
      return;
    }
    this.runningJobs.add(lockName);
    try {
      await job();
    } finally {
      this.runningJobs.delete(lockName);
    }
  }

  @Cron("0 * * * *")
  async deleteExpiredShares() {
    await this.runExclusive("deleteExpiredShares", async () => {
      const expiredShares = await this.prisma.share.findMany({
        where: {
          expiration: {
            gte: NEVER_EXPIRES_CUTOFF_DATE,
            lt: new Date(),
          },
        },
      });

      for (const expiredShare of expiredShares) {
        try {
          await this.fileService.deleteAllFiles(expiredShare.id);
        } catch (e) {
          this.logger.warn(
            `Failed to delete files for share ${expiredShare.id}: ${(e as Error).message}`,
          );
        }
        await this.prisma.share.deleteMany({
          where: { id: expiredShare.id },
        });
      }

      if (expiredShares.length > 0) {
        this.logger.log(`Deleted ${expiredShares.length} expired shares`);
      }
    });
  }

  @Cron("0 * * * *")
  async deleteExpiredReverseShares() {
    await this.runExclusive("deleteExpiredReverseShares", async () => {
      const expiredReverseShares = await this.prisma.reverseShare.findMany({
        where: {
          shareExpiration: {
            gte: NEVER_EXPIRES_CUTOFF_DATE,
            lt: new Date(),
          },
        },
      });

      for (const expiredReverseShare of expiredReverseShares) {
        await this.reverseShareService.remove(expiredReverseShare.id);
      }

      if (expiredReverseShares.length > 0) {
        this.logger.log(
          `Deleted ${expiredReverseShares.length} expired reverse shares`,
        );
      }
    });
  }

  @Cron(ABANDONED_UPLOAD_CLEANUP_CRON)
  async deleteUnfinishedShares() {
    await this.runExclusive("deleteUnfinishedShares", async () => {
      const inactivityCutoff = getAbandonedUploadCutoff();
      const unfinishedShares = await this.prisma.share.findMany({
        where: {
          uploadLastActivityAt: { lt: inactivityCutoff },
          uploadCleanupStartedAt: null,
          uploadLocked: false,
        },
      });
      let deletedShares = 0;
      let relockedShares = 0;

      for (const unfinishedShare of unfinishedShares) {
        // An unlocked share that was completed previously is being edited, not
        // created. If that editing client disappeared, restore the last safe
        // access state instead of deleting the share and all of its old files.
        if (unfinishedShare.hasBeenCompleted) {
          const relocked = await this.prisma.share.updateMany({
            where: {
              id: unfinishedShare.id,
              hasBeenCompleted: true,
              uploadLocked: false,
              uploadCleanupStartedAt: null,
              uploadLastActivityAt: { lt: inactivityCutoff },
            },
            data: { uploadLocked: true },
          });
          if (relocked.count > 0) relockedShares++;
          continue;
        }

        // Protect transfers still handled by an older pre-heartbeat process.
        // S3 multipart timestamps and local file mtimes remain authoritative
        // even when the old backend cannot update the Share row.
        try {
          const storageActivity =
            await this.fileService.getRecentUploadActivity(
              unfinishedShare.id,
              unfinishedShare.storageProvider,
              inactivityCutoff,
            );
          if (storageActivity) {
            await this.prisma.share.updateMany({
              where: {
                id: unfinishedShare.id,
                uploadLocked: false,
                uploadCleanupStartedAt: null,
                uploadLastActivityAt: { lt: inactivityCutoff },
              },
              data: { uploadLastActivityAt: new Date() },
            });
            continue;
          }
        } catch (e) {
          // Fail closed: an unavailable storage probe must never turn into an
          // unverified destructive cleanup. Retry on the next five-minute run.
          this.logger.warn(
            `Could not verify upload activity for unfinished share ${unfinishedShare.id}: ${(e as Error).message}`,
          );
          continue;
        }

        // Claim cleanup atomically against heartbeats and upload requests. If
        // activity won the race after findMany, this update affects no row.
        const cleanupStartedAt = new Date();
        const claimed = await this.prisma.share.updateMany({
          where: {
            id: unfinishedShare.id,
            uploadLocked: false,
            uploadCleanupStartedAt: null,
            uploadLastActivityAt: { lt: inactivityCutoff },
          },
          data: { uploadCleanupStartedAt: cleanupStartedAt },
        });
        if (claimed.count === 0) continue;

        // Delete files FIRST, then DB record. If file deletion fails
        // the DB record survives and we can retry next cycle.
        try {
          await this.fileService.deleteAllFiles(
            unfinishedShare.id,
            unfinishedShare.storageProvider,
          );
        } catch (e) {
          this.logger.warn(
            `Failed to delete files for unfinished share ${unfinishedShare.id}: ${(e as Error).message}`,
          );
          await this.prisma.share.updateMany({
            where: {
              id: unfinishedShare.id,
              uploadCleanupStartedAt: cleanupStartedAt,
              uploadLocked: false,
            },
            data: { uploadCleanupStartedAt: null },
          });
          continue;
        }

        const deleted = await this.prisma.share.deleteMany({
          where: {
            id: unfinishedShare.id,
            uploadCleanupStartedAt: cleanupStartedAt,
            uploadLocked: false,
          },
        });
        if (deleted.count > 0) {
          deletedShares++;
        } else {
          await this.prisma.share.updateMany({
            where: {
              id: unfinishedShare.id,
              uploadCleanupStartedAt: cleanupStartedAt,
            },
            data: { uploadCleanupStartedAt: null },
          });
          this.logger.warn(
            `Cleanup claim changed before unfinished share ${unfinishedShare.id} could be deleted`,
          );
        }
      }

      if (deletedShares > 0) {
        this.logger.log(`Deleted ${deletedShares} unfinished shares`);
      }
      if (relockedShares > 0) {
        this.logger.log(
          `Relocked ${relockedShares} abandoned share edits without deleting files`,
        );
      }
    });
  }

  @Cron("0 0 * * *")
  async deleteTemporaryFiles() {
    await this.runExclusive("deleteTemporaryFiles", async () => {
      let filesDeleted = 0;

      const shareDirectories = fs
        .readdirSync(SHARE_DIRECTORY, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const shareDirectory of shareDirectories) {
        const temporaryFiles = fs
          .readdirSync(`${SHARE_DIRECTORY}/${shareDirectory}`)
          .filter((file) => file.endsWith(".tmp-chunk"));

        for (const file of temporaryFiles) {
          const stats = fs.statSync(
            `${SHARE_DIRECTORY}/${shareDirectory}/${file}`,
          );
          const isOlderThanOneDay = moment(stats.mtime)
            .add(1, "day")
            .isBefore(moment());

          if (isOlderThanOneDay) {
            fs.rmSync(`${SHARE_DIRECTORY}/${shareDirectory}/${file}`);
            filesDeleted++;
          }
        }
      }

      this.logger.log(`Deleted ${filesDeleted} temporary files`);
    });
  }

  /**
   * Purge stale S3 multipart uploads that have been abandoned for
   * more than 2 hours (e.g. after server restart or network failure).
   * This catches uploads that the in-memory cleanup in S3FileService
   * cannot track because the process was restarted.
   */
  @Cron("30 */6 * * *")
  async cleanupStaleS3Multiparts() {
    await this.runExclusive("cleanupStaleS3Multiparts", async () => {
      try {
        await this.fileService.cleanupStaleS3Multiparts();
      } catch (e) {
        this.logger.warn(
          `S3 multipart cleanup failed: ${(e as Error).message}`,
        );
      }
    });
  }

  @Cron("1 * * * *")
  async deleteExpiredUnverifiedAccounts() {
    await this.runExclusive("deleteExpiredUnverifiedAccounts", async () => {
      // Deleting an account is irreversible, and an instance that cannot send
      // a verification link leaves its users no way to keep theirs. Blocking
      // at J+5 still applies and recovers on its own once SMTP is restored.
      if (!this.config.get("smtp.enabled")) {
        this.logger.warn(
          "Skipped the unverified-account cleanup: SMTP is not configured",
        );
        return;
      }
      const now = new Date();
      const deletionCutoff = new Date(
        now.getTime() - 14 * 24 * 60 * 60 * 1000,
      );
      const staleClaimCutoff = new Date(
        now.getTime() - 6 * 60 * 60 * 1000,
      );
      const candidates = await this.prisma.user.findMany({
        where: {
          emailVerificationRequiredAt: { lte: deletionCutoff },
          emailVerifiedAt: null,
          OR: [
            { emailVerificationDeletionStartedAt: null },
            {
              emailVerificationDeletionStartedAt: {
                lte: staleClaimCutoff,
              },
            },
          ],
        },
        include: { shares: true },
      });

      let deletedAccounts = 0;
      for (const candidate of candidates) {
        const claimStartedAt = new Date();
        const claimed = await this.prisma.user.updateMany({
          where: {
            id: candidate.id,
            emailVerificationRequiredAt: { lte: deletionCutoff },
            emailVerifiedAt: null,
            ...(candidate.emailVerificationDeletionStartedAt
              ? {
                  emailVerificationDeletionStartedAt:
                    candidate.emailVerificationDeletionStartedAt,
                }
              : { emailVerificationDeletionStartedAt: null }),
          },
          data: {
            emailVerificationDeletionStartedAt: claimStartedAt,
          },
        });
        if (claimed.count !== 1) continue;

        try {
          // Keep the existing account-deletion ordering: remove physical share
          // data first, then rely on cascading foreign keys for database data.
          for (const share of candidate.shares) {
            await this.fileService.deleteAllFiles(share.id);
          }
        } catch (error) {
          this.logger.warn(
            `Could not delete data for an expired unverified account: ${(error as Error).message}`,
          );
          await this.prisma.user.updateMany({
            where: {
              id: candidate.id,
              emailVerificationDeletionStartedAt: claimStartedAt,
              emailVerifiedAt: null,
            },
            data: { emailVerificationDeletionStartedAt: null },
          });
          continue;
        }

        const deleted = await this.prisma.user.deleteMany({
          where: {
            id: candidate.id,
            emailVerifiedAt: null,
            emailVerificationDeletionStartedAt: claimStartedAt,
          },
        });
        deletedAccounts += deleted.count;
      }

      if (deletedAccounts > 0) {
        this.logger.log(
          `Deleted ${deletedAccounts} account(s) left unverified for 14 days`,
        );
      }
    });
  }

  @Cron("1 * * * *")
  async deleteExpiredTokens() {
    await this.runExclusive("deleteExpiredTokens", async () => {
      const { count: refreshTokenCount } =
        await this.prisma.refreshToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

      const { count: loginTokenCount } =
        await this.prisma.loginToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

      const { count: resetPasswordTokenCount } =
        await this.prisma.resetPasswordToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

      const { count: emailVerificationTokenCount } =
        await this.prisma.emailVerificationToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

      const deletedTokensCount =
        refreshTokenCount +
        loginTokenCount +
        resetPasswordTokenCount +
        emailVerificationTokenCount;

      if (deletedTokensCount > 0) {
        this.logger.log(`Deleted ${deletedTokensCount} expired refresh tokens`);
      }
    });
  }

  /**
   * Purge signature documents whose source file has been deleted for more than 6 months.
   * Runs daily at 4:00 AM.
   */
  @Cron("0 4 * * *")
  async purgeDeletedSignatureDocuments() {
    await this.runExclusive("purgeDeletedSignatureDocuments", async () => {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const { count } = await this.prisma.signatureDocument.deleteMany({
        where: {
          fileDeletedAt: { not: null, lt: sixMonthsAgo },
        },
      });

      if (count > 0) {
        this.logger.log(
          `Purged ${count} signature documents deleted over 6 months ago`,
        );
      }
    });
  }

  /** Send due Team compliance reports every morning (deduplicated in DB). */
  @Cron("15 7 * * *", { timeZone: "Europe/Paris" })
  async sendTeamAuditReports() {
    await this.runExclusive("sendTeamAuditReports", async () => {
      const result = await this.teamAuditService.dispatchScheduledReports();
      if (result.sent > 0) {
        this.logger.log(`Sent ${result.sent} automatic Team audit report(s)`);
      }
    });
  }

  /** Remind Team admins shortly before an assisted key rotation becomes due. */
  @Cron("30 7 * * *", { timeZone: "Europe/Paris" })
  async sendTeamKeyRotationReminders() {
    await this.runExclusive("sendTeamKeyRotationReminders", async () => {
      const result = await this.teamService.sendKeyRotationReminders();
      if (result.sent > 0) {
        this.logger.log(`Sent ${result.sent} Team key-rotation reminder(s)`);
      }
    });
  }
}
