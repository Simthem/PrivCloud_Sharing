import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import { PushService } from "src/push/push.service";

export type TeamNotificationType =
  | "FILE_SHARED"
  | "FILE_UPLOADED"
  | "FILE_DELETED"
  | "GRANT_RECEIVED"
  | "GRANT_REVOKED"
  | "KEY_ROTATED"
  | "MEMBER_JOINED"
  | "MEMBER_LEFT"
  | "SIGNATURE_REQUESTED"
  | "SIGNATURE_SIGNED"
  | "SIGNATURE_COMPLETED";

interface CreateNotificationParams {
  type: TeamNotificationType;
  title: string;
  teamId: string;
  userId: string; // Recipient
  actorId?: string;
  teamFileId?: string;
  folderId?: string;
  signingDocumentId?: string;
  // Used only for non-sensitive legacy notifications. Encrypted notifications
  // always use an opaque resolver URL instead.
  url?: string;
  metadata?: Record<string, unknown>;
  encryptedMetadata?: string;
}

@Injectable()
export class TeamNotificationService {
  private readonly logger = new Logger(TeamNotificationService.name);

  constructor(
    private prisma: PrismaService,
    private pushService: PushService,
  ) {}

  /**
   * Create a notification for a specific team member.
   * Also sends a push notification if the user has push enabled.
   */
  async notify(params: CreateNotificationParams) {
    const notification = await this.prisma.teamNotification.create({
      data: {
        type: params.type,
        title: params.title,
        teamId: params.teamId,
        userId: params.userId,
        actorId: params.actorId,
        teamFileId: params.teamFileId,
        folderId: params.folderId,
        metadata: params.encryptedMetadata
          ? null
          : params.metadata
            ? JSON.stringify(params.metadata)
            : null,
        encryptedMetadata: params.encryptedMetadata || null,
      },
    });

    // Build navigation URL: folder with file highlight if available
    // A push worker cannot decrypt E2E metadata. It therefore opens this
    // authenticated, opaque resolver; the browser decrypts the action then
    // redirects immediately to the signature, tracking page or download.
    const url = params.encryptedMetadata
      ? `/notifications/open/${notification.id}`
      : this.buildNavigationUrl(params);

    // Push notification body: generic when E2E encrypted, detailed when plaintext
    const pushBody = params.encryptedMetadata
      ? "Vous avez reçu une nouvelle notification chiffrée"
      : this.buildPushBody(params);

    // Send push notification (non-blocking)
    this.pushService
      .sendToUser(params.userId, {
        title: params.title,
        body: pushBody,
        url,
      })
      .catch((err) => {
        this.logger.debug(
          `Push send failed for ${params.userId}: ${err.message}`,
        );
      });

    return notification;
  }

  /**
   * Notify all team members (except the actor) about an event.
   * Respects pushNotifMode: SHARES_ONLY members only get push for
   * FILE_SHARED, GRANT_RECEIVED types. All types create DB records
   * (for email digest) regardless.
   */
  async notifyTeamMembers(
    teamId: string,
    actorId: string,
    type: TeamNotificationType,
    title: string,
    opts?: {
      teamFileId?: string;
      folderId?: string;
      signingDocumentId?: string;
      metadata?: Record<string, unknown>;
      excludeUserIds?: string[];
    },
  ) {
    // Single query: get members + folder access info in one shot
    const members = await this.prisma.teamMember.findMany({
      where: {
        teamId,
        isActive: true,
        userId: { notIn: [actorId, ...(opts?.excludeUserIds || [])] },
      },
      include: opts?.folderId
        ? {
            folderAccess: {
              where: { folderId: opts.folderId },
              select: { id: true },
            },
          }
        : undefined,
    });

    // Filter by folder access: skip members without access (unless OWNER/ADMIN)
    const eligibleMembers = members.filter((m) => {
      if (!opts?.folderId) return true;
      if (m.role === "OWNER" || m.role === "ADMIN") return true;
      return (m as any).folderAccess?.length > 0;
    });

    if (eligibleMembers.length === 0) return [];

    // Determine if this is a "direct share" type (for SHARES_ONLY filtering)
    const isDirectShareType =
      type === "FILE_SHARED" || type === "GRANT_RECEIVED";

    // Filter out members whose pushNotifMode is SHARES_ONLY for non-share events.
    // This applies to BOTH DB records and push (user chose not to be notified at all).
    const notifiableMembers = eligibleMembers.filter((m) => {
      if (m.pushNotifMode === "SHARES_ONLY" && !isDirectShareType) return false;
      return true;
    });

    if (notifiableMembers.length === 0) return [];

    // Batch create all DB notifications at once
    const notifData = notifiableMembers.map((m) => ({
      type,
      title,
      teamId,
      userId: m.userId,
      actorId,
      teamFileId: opts?.teamFileId || null,
      folderId: opts?.folderId || null,
      metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
    }));

    await this.prisma.teamNotification.createMany({ data: notifData });

    // Build navigation URL once (same for all recipients)
    const url = this.buildNavigationUrl({
      type,
      title,
      teamId,
      userId: "",
      actorId,
      teamFileId: opts?.teamFileId,
      folderId: opts?.folderId,
      metadata: opts?.metadata,
    });

    // Send push notifications in parallel (all notifiable members already filtered)
    const pushBody = this.buildPushBody({
      type,
      title,
      teamId,
      userId: "",
      actorId,
      metadata: opts?.metadata,
    });

    const pushPromises = notifiableMembers.map((m) =>
      this.pushService
        .sendToUser(m.userId, { title, body: pushBody, url })
        .catch((err) => {
          this.logger.debug(`Push failed for ${m.userId}: ${err.message}`);
        }),
    );

    // Fire all pushes in parallel (non-blocking for the caller)
    Promise.all(pushPromises).catch(() => {});

    return notifData;
  }

  /**
   * Get notifications for a user (paginated).
   * Sorted by creation time descending (newest first).
   */
  async getNotifications(
    userId: string,
    opts?: {
      teamId?: string;
      unreadOnly?: boolean;
      limit?: number;
      offset?: number;
    },
  ) {
    const where: any = { userId };
    if (opts?.teamId) where.teamId = opts.teamId;
    if (opts?.unreadOnly) where.isRead = false;

    const [notifications, total] = await Promise.all([
      this.prisma.teamNotification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: opts?.limit || 50,
        skip: opts?.offset || 0,
        include: {
          team: { select: { id: true, name: true, slug: true } },
          teamFile: { select: { id: true, name: true } },
          folder: { select: { id: true, name: true } },
        },
      }),
      this.prisma.teamNotification.count({ where }),
    ]);

    return {
      notifications,
      total,
      unreadCount: opts?.unreadOnly
        ? total
        : await this.prisma.teamNotification.count({
            where: {
              userId,
              isRead: false,
              ...(opts?.teamId ? { teamId: opts.teamId } : {}),
            },
          }),
    };
  }

  async getNotification(notificationId: string, userId: string) {
    return this.prisma.teamNotification.findFirst({
      where: { id: notificationId, userId },
      include: {
        team: { select: { id: true, name: true, slug: true } },
        teamFile: { select: { id: true, name: true } },
        folder: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Mark a notification as read.
   */
  async markAsRead(notificationId: string, userId: string) {
    const notification = await this.prisma.teamNotification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) return null;

    return this.prisma.teamNotification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  /**
   * Mark all notifications as read for a user (optionally scoped to a team).
   */
  async markAllAsRead(userId: string, teamId?: string) {
    const where: any = { userId, isRead: false };
    if (teamId) where.teamId = teamId;

    const result = await this.prisma.teamNotification.updateMany({
      where,
      data: { isRead: true },
    });

    return { markedCount: result.count };
  }

  /**
   * Get unread notification count (for badge display).
   */
  async getUnreadCount(userId: string, teamId?: string) {
    const where: any = { userId, isRead: false };
    if (teamId) where.teamId = teamId;

    return this.prisma.teamNotification.count({ where });
  }

  /**
   * Delete all notifications for a user (optionally scoped to a team).
   */
  async deleteAll(userId: string, teamId?: string) {
    const where: any = { userId };
    if (teamId) where.teamId = teamId;

    const result = await this.prisma.teamNotification.deleteMany({ where });
    return { deletedCount: result.count };
  }

  /**
   * Periodic cleanup: remove old read notifications (90+ days).
   */
  async cleanupOldNotifications() {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const result = await this.prisma.teamNotification.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        isRead: true, // Only delete read notifications
      },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} old team notifications`);
    }

    return result.count;
  }

  private buildNavigationUrl(params: CreateNotificationParams): string {
    if (params.url?.startsWith("/")) return params.url;
    if (params.signingDocumentId) {
      return `/signing/${params.signingDocumentId}`;
    }
    if (params.teamId && params.folderId) {
      const base = `/team/${params.teamId}/folder/${params.folderId}`;
      const highlightId = params.teamFileId || params.metadata?.highlightFileId;
      return highlightId ? `${base}?highlight=${highlightId}` : base;
    }
    if (params.teamId) {
      return `/team/${params.teamId}`;
    }
    return `/team?tab=notifications`;
  }

  private buildPushBody(params: CreateNotificationParams): string {
    const meta = params.metadata || {};
    switch (params.type) {
      case "FILE_SHARED":
        return `${meta.senderName || "Un membre"} a partagé "${meta.fileName || "un fichier"}" avec vous`;
      case "FILE_UPLOADED":
        return `${meta.senderName || "Un membre"} a uploadé "${meta.fileName || "un fichier"}"`;
      case "FILE_DELETED":
        return `"${meta.fileName || "Un fichier"}" a été supprimé`;
      case "GRANT_RECEIVED":
        return `Vous avez reçu l'accès à "${meta.fileName || "un fichier"}"`;
      case "GRANT_REVOKED":
        return `Votre accès à "${meta.fileName || "un fichier"}" a été révoqué`;
      case "KEY_ROTATED":
        return `Les clés de l'équipe ont été renouvelées`;
      case "MEMBER_JOINED":
        return `${meta.memberName || "Un nouveau membre"} a rejoint l'équipe`;
      case "MEMBER_LEFT":
        return `${meta.memberName || "Un membre"} a quitté l'équipe`;
      case "SIGNATURE_REQUESTED":
        return `${meta.actorName || "Un membre"} a demandé la signature de "${meta.fileName || "un document"}"`;
      case "SIGNATURE_SIGNED":
        return `${meta.signerName || "Un signataire"} a signé "${meta.fileName || "un document"}"${meta.signedCount && meta.totalSigners ? ` (${meta.signedCount}/${meta.totalSigners})` : ""}`;
      case "SIGNATURE_COMPLETED":
        return `Le document "${meta.fileName || ""}" est prêt au téléchargement`;
      default:
        return params.title;
    }
  }
}
