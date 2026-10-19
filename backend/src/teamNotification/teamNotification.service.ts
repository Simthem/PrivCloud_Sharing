import { fileRequestServiceMessage } from "src/teamFileRequest/team-file-request-i18n";
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import { PushService } from "src/push/push.service";
import {
  GenericTeamNotificationType,
  isGenericTeamNotificationType,
  navigationMetadata,
  TEAM_NOTIFICATION_PUSH_BODY,
  teamNotificationTitle,
} from "./team-notification-messages";

export type TeamNotificationType =
  | "EXTERNAL_ACCESS_ENDED"
  | "FILE_REQUESTED"
  | "FILE_REQUEST_SUBMITTED"
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

export function normalizeNotificationPagination(
  limit?: number,
  offset?: number,
) {
  const hasValidLimit =
    typeof limit === "number" && Number.isSafeInteger(limit);
  const hasValidOffset =
    typeof offset === "number" && Number.isSafeInteger(offset);
  return {
    limit: hasValidLimit ? Math.min(100, Math.max(1, limit)) : 50,
    offset: hasValidOffset ? Math.max(0, offset) : 0,
  };
}

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
  // Only navigation identifiers are kept, see navigationMetadata().
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

  /** Requests insert their notification in the same transaction as the action.
   * Deliver only generic text outside that transaction. The stored notification remains
   * available if push delivery fails or the process stops here. */
  deliverExternalRevocationNotification(
    notification: { id: string; userId: string; title: string; teamId: string },
    body: string,
  ) {
    const url = `/team/${encodeURIComponent(notification.teamId)}/settings#external-contractors`;
    const payload = { title: notification.title, body, url };
    void this.pushService.sendToUser(notification.userId, payload).catch(() => {
      this.logger.debug("External-access push delivery failed");
    });
  }

  deliverFileRequestNotification(notification: {
    id: string;
    userId: string;
    title: string;
    teamId: string;
  }) {
    const url = `/notifications/open/${notification.id}`;
    const payload = {
      title: notification.title,
      body: fileRequestServiceMessage("pushBody"),
      url,
    };
    void this.pushService.sendToUser(notification.userId, payload).catch(() => {
      this.logger.debug("File request push delivery failed");
    });
  }

  /**
   * Create a notification for a specific team member.
   * Also sends a push notification if the user has push enabled.
   */
  async notify(params: CreateNotificationParams) {
    const title = isGenericTeamNotificationType(params.type)
      ? teamNotificationTitle(params.type)
      : params.title;
    const metadata = params.encryptedMetadata
      ? undefined
      : navigationMetadata(params.metadata);
    const notification = await this.prisma.teamNotification.create({
      data: {
        type: params.type,
        title,
        teamId: params.teamId,
        userId: params.userId,
        actorId: params.actorId,
        teamFileId: params.teamFileId,
        folderId: params.folderId,
        metadata: metadata ? JSON.stringify(metadata) : null,
        encryptedMetadata: params.encryptedMetadata || null,
      },
    });

    // Build navigation URL: folder with file highlight if available
    // A push worker cannot decrypt E2E metadata. It therefore opens this
    // authenticated, opaque resolver; the browser decrypts the action then
    // redirects immediately to the signature, tracking page or download.
    const url = params.encryptedMetadata
      ? `/notifications/open/${notification.id}`
      : this.buildNavigationUrl({ ...params, metadata });

    // Push services and lock screens only ever get generic text.
    const pushBody = TEAM_NOTIFICATION_PUSH_BODY;

    // Send push notification (non-blocking)
    this.pushService
      .sendToUser(params.userId, {
        title,
        body: pushBody,
        url,
      })
      .catch(() => {
        this.logger.debug("Push send failed");
      });

    return notification;
  }

  /**
   * Notify all team members (except the actor) about an event. The text is
   * the generic one of the event type, see team-notification-messages.ts.
   * Respects pushNotifMode: SHARES_ONLY members only get push for
   * FILE_SHARED, GRANT_RECEIVED types. All types create DB records
   * (for email digest) regardless.
   */
  async notifyTeamMembers(
    teamId: string,
    actorId: string,
    type: GenericTeamNotificationType,
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

    const title = teamNotificationTitle(type);
    const metadata = navigationMetadata(opts?.metadata);

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
      metadata: metadata ? JSON.stringify(metadata) : null,
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
      metadata,
    });

    // Send push notifications in parallel (all notifiable members already filtered)
    const pushBody = TEAM_NOTIFICATION_PUSH_BODY;

    const pushPromises = notifiableMembers.map((m) =>
      this.pushService
        .sendToUser(m.userId, { title, body: pushBody, url })
        .catch(() => {
          this.logger.debug(`Push failed for ${m.userId}`);
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
    const pagination = normalizeNotificationPagination(
      opts?.limit,
      opts?.offset,
    );

    const [notifications, total] = await Promise.all([
      this.prisma.teamNotification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pagination.limit,
        skip: pagination.offset,
        include: {
          team: { select: { id: true } },
          teamFile: { select: { id: true } },
          folder: { select: { id: true } },
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
        team: { select: { id: true } },
        teamFile: { select: { id: true } },
        folder: { select: { id: true } },
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
}
