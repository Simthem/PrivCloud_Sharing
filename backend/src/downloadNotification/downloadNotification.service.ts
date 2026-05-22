import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Share } from "@prisma/client";
import moment from "moment";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import { PushService } from "src/push/push.service";

/** Cooldown in minutes for INSTANT mode (max 1 email per cooldown) */
const INSTANT_COOLDOWN_MINUTES = 10;

@Injectable()
export class DownloadNotificationService {
  private readonly logger = new Logger(DownloadNotificationService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private pushService: PushService,
    private config: ConfigService,
  ) {}

  // --- Called when a file is downloaded ------------------------------------
  async onDownload(share: Share, isRegisteredDownloader: boolean) {
    if (!share.notifyOnDownload) return;

    // Record the download event (RGPD-safe: no IP, no user-agent, no file info)
    await this.prisma.downloadEvent.create({
      data: {
        shareId: share.id,
        byRegisteredUser: isRegisteredDownloader,
      },
    });

    // Push notification is ALWAYS instant (regardless of email batching mode)
    if (share.creatorId) {
      const shareUrl = `${this.config.get("general.appUrl")}/s/${share.id}`;
      const dateStr = moment().format("DD/MM/YYYY HH:mm");
      const displayName = share.name || "Sans titre";
      void this.pushService.sendToUser(share.creatorId, {
        title: this.config.get("email.downloadNotificationSubject"),
        body: `"${displayName}" -- ${dateStr}`,
        url: shareUrl,
      });
    }

    // Determine notification mode (controls email batching only)
    const mode = await this.getNotificationMode(share);

    if (mode === "INSTANT") {
      await this.tryInstantNotification(share);
    }
    // DIGEST and WEEKLY emails are handled by cron jobs
  }

  // --- Resolve effective notification mode ---------------------------------
  private async getNotificationMode(share: Share): Promise<string> {
    if (!share.creatorId) {
      // Anonymous creator → forced DIGEST
      return "DIGEST";
    }

    const user = await this.prisma.user.findUnique({
      where: { id: share.creatorId },
      select: { notificationMode: true },
    });

    return user?.notificationMode ?? "DIGEST";
  }

  // --- INSTANT notification (with cooldown) --------------------------------
  private async tryInstantNotification(share: Share) {
    const now = new Date();
    const cooldownThreshold = moment(now)
      .subtract(INSTANT_COOLDOWN_MINUTES, "minutes")
      .toDate();

    // Check cooldown: if we sent a notification recently, skip (digest cron will handle it)
    if (
      share.lastDownloadNotifSentAt &&
      share.lastDownloadNotifSentAt > cooldownThreshold
    ) {
      return;
    }

    // Get pending (un-notified) events for this share
    const pendingEvents = await this.prisma.downloadEvent.findMany({
      where: { shareId: share.id, notified: false },
    });

    if (pendingEvents.length === 0) return;

    const recipientEmail = await this.getRecipientEmail(share);
    if (!recipientEmail) return;

    const shareUrl = `${this.config.get("general.appUrl")}/s/${share.id}`;
    const dateStr = moment(now).format("DD/MM/YYYY HH:mm");
    const displayName = share.name || "Sans titre";

    try {
      await this.emailService.sendDownloadNotification(
        recipientEmail,
        displayName,
        dateStr,
        shareUrl,
      );
    } catch (e) {
      this.logger.error(
        `Failed to send instant download notification for share ${share.id}`,
        (e as Error).message,
      );
      return;
    }

    // Push already sent immediately in onDownload() — no duplicate here

    // Mark events as notified and update cooldown timestamp
    await this.prisma.downloadEvent.updateMany({
      where: { id: { in: pendingEvents.map((e) => e.id) } },
      data: { notified: true },
    });

    await this.prisma.share.update({
      where: { id: share.id },
      data: { lastDownloadNotifSentAt: now },
    });
  }

  // --- DIGEST cron: runs every 10 minutes ----------------------------------
  @Cron(CronExpression.EVERY_10_MINUTES)
  async processDigest() {
    // Find all shares with pending (un-notified) download events
    const shares = await this.prisma.share.findMany({
      where: {
        notifyOnDownload: true,
        downloadEvents: { some: { notified: false } },
      },
      include: {
        creator: { select: { notificationMode: true, email: true } },
        _count: { select: { downloadEvents: { where: { notified: false } } } },
      },
    });

    for (const share of shares) {
      const mode = !share.creatorId
        ? "DIGEST"
        : (share.creator?.notificationMode ?? "DIGEST");

      // Only process DIGEST and INSTANT-with-cooldown-still-pending
      if (mode === "WEEKLY") continue;

      // For INSTANT: only process if cooldown has passed (handles queued events)
      if (mode === "INSTANT") {
        const cooldownThreshold = moment()
          .subtract(INSTANT_COOLDOWN_MINUTES, "minutes")
          .toDate();
        if (
          share.lastDownloadNotifSentAt &&
          share.lastDownloadNotifSentAt > cooldownThreshold
        ) {
          continue;
        }
      }

      const pendingCount = share._count.downloadEvents;
      if (pendingCount === 0) continue;

      await this.sendDigestForShare(share, pendingCount);
    }
  }

  // --- WEEKLY cron: runs every Monday at 08:00 -----------------------------
  @Cron("0 8 * * 1")
  async processWeeklySummary() {
    // Find all shares with un-notified events belonging to WEEKLY-mode users
    const shares = await this.prisma.share.findMany({
      where: {
        notifyOnDownload: true,
        downloadEvents: { some: { notified: false } },
        creator: { notificationMode: "WEEKLY" },
      },
      include: {
        creator: { select: { notificationMode: true, email: true } },
        _count: { select: { downloadEvents: { where: { notified: false } } } },
      },
    });

    // Group by recipient email for a consolidated weekly summary
    const byRecipient = new Map<
      string,
      { shareName: string; count: number; shareId: string }[]
    >();

    for (const share of shares) {
      const email = share.creator?.email ?? share.senderEmail;
      if (!email) continue;

      if (!byRecipient.has(email)) byRecipient.set(email, []);
      byRecipient.get(email)!.push({
        shareName: share.name,
        count: share._count.downloadEvents,
        shareId: share.id,
      });
    }

    const appUrl = this.config.get("general.appUrl");

    for (const [email, entries] of byRecipient) {
      // Build digest text (RGPD-safe: only share name + count + link)
      const digestLines = entries.map(
        (e) =>
          `- "${e.shareName || "Sans titre"}": ${e.count} téléchargement${e.count > 1 ? "s" : ""} -- ${appUrl}/s/${e.shareId}`,
      );

      try {
        await this.emailService.sendDownloadDigest(
          email,
          digestLines.join("\n"),
          "weekly",
        );
      } catch (e) {
        this.logger.error(
          `Failed to send weekly summary to ${email}`,
          (e as Error).message,
        );
        continue;
      }

    }

    // Mark all processed events as notified
    const shareIds = shares.map((s) => s.id);
    if (shareIds.length > 0) {
      await this.prisma.downloadEvent.updateMany({
        where: { shareId: { in: shareIds }, notified: false },
        data: { notified: true },
      });
    }
  }

  // --- Send digest for a single share --------------------------------------
  private async sendDigestForShare(
    share: { id: string; name: string; creatorId: string | null; senderEmail: string | null; creator?: { email: string | null } | null },
    count: number,
  ) {
    const recipientEmail = share.creator?.email ?? share.senderEmail;
    if (!recipientEmail) return;

    const appUrl = this.config.get("general.appUrl");
    const shareUrl = `${appUrl}/s/${share.id}`;
    const displayName = share.name || "Sans titre";
    const digestLine = `- "${displayName}": ${count} téléchargement${count > 1 ? "s" : ""} -- ${shareUrl}`;

    try {
      await this.emailService.sendDownloadDigest(
        recipientEmail,
        digestLine,
        "digest",
      );
    } catch (e) {
      this.logger.error(
        `Failed to send digest for share ${share.id}`,
        (e as Error).message,
      );
      return;
    }

    // Mark events as notified
    await this.prisma.downloadEvent.updateMany({
      where: { shareId: share.id, notified: false },
      data: { notified: true },
    });

    await this.prisma.share.update({
      where: { id: share.id },
      data: { lastDownloadNotifSentAt: new Date() },
    });
  }

  // --- Resolve recipient email ---------------------------------------------
  private async getRecipientEmail(share: Share): Promise<string | null> {
    if (share.creatorId) {
      const user = await this.prisma.user.findUnique({
        where: { id: share.creatorId },
        select: { email: true },
      });
      return user?.email ?? null;
    }
    // Anonymous creator: use senderEmail from share
    return share.senderEmail ?? null;
  }

  // --- Cleanup old notified events (runs daily) ---------------------------
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupOldEvents() {
    const threshold = moment().subtract(30, "days").toDate();
    const { count } = await this.prisma.downloadEvent.deleteMany({
      where: { notified: true, createdAt: { lt: threshold } },
    });
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} old download events`);
    }
  }
}
