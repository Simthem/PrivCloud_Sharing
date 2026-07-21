import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { User } from "@prisma/client";
import { AccessGrantService } from "./grant.service";
import { CreateAccessGrantDTO, BulkCreateGrantsDTO } from "./dto/crypto.dto";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "src/config/config.service";
import { SafeIdPipe } from "src/share/pipe/safeId.pipe";

@Controller("crypto/grants")
export class AccessGrantController {
  private readonly logger = new Logger(AccessGrantController.name);

  constructor(
    private grantService: AccessGrantService,
    private teamNotificationService: TeamNotificationService,
    private emailService: EmailService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Create an access grant (encrypted DEK for a user).
   * The encryption is done CLIENT-SIDE - server only stores ciphertext.
   */
  @Post()
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: 60, limit: 100 } })
  async createGrant(@GetUser() user: User, @Body() dto: CreateAccessGrantDTO) {
    return this.grantService.createGrant(user.id, dto);
  }

  /**
   * Bulk create grants (share with entire team at once).
   * Also sends notifications and emails to recipients.
   */
  @Post("bulk")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: 60, limit: 10 } })
  async createBulkGrants(@GetUser() user: User, @Body() dto: BulkCreateGrantsDTO) {
    const result = await this.grantService.createBulkGrants(user.id, dto);

    // Send notifications + emails for successful grants (non-blocking)
    this.sendGrantNotifications(user, dto, result).catch((err) =>
      this.logger.error(`Failed to send grant notifications: ${err.message}`),
    );

    return result;
  }

  private async sendGrantNotifications(
    actor: User,
    dto: BulkCreateGrantsDTO,
    result: { success: number; results: Array<{ recipientUserId: string; result: any }> },
  ) {
    if (result.success === 0) return;

    // Determine team context from the first grant's teamFileId
    const firstGrant = dto.grants[0];
    let teamId: string | null = null;
    let teamName: string | null = null;
    const teamFileId: string | null = firstGrant?.teamFileId || null;
    let folderId: string | null = null;
    let fileName: string | null = null;
    let shareId: string | null = firstGrant?.shareId || null;

    if (teamFileId) {
      const teamFile = await this.prisma.teamFile.findUnique({
        where: { id: teamFileId },
        include: { folder: { include: { team: true } } },
      });
      if (teamFile) {
        teamId = teamFile.folder.teamId;
        teamName = teamFile.folder.team.name;
        folderId = teamFile.folderId;
        fileName = teamFile.name;
      }
    } else if (firstGrant?.fileId) {
      const file = await this.prisma.file.findUnique({
        where: { id: firstGrant.fileId },
        include: { share: { include: { teamFolder: { include: { team: true } } } } },
      });
      if (file) {
        fileName = file.name;
        teamId = file.share?.teamFolder?.teamId || null;
        teamName = file.share?.teamFolder?.team?.name || null;
        folderId = file.share?.teamFolderId || null;
        shareId = file.share?.id || shareId;
      }
    }

    // Notify each successful recipient
    const successfulRecipients = result.results.filter((r) => r.result !== null);

    // Log E2E_SHARE activity in the team feed (admin visibility)
    if (teamId && successfulRecipients.length > 0) {
      this.prisma.teamAccessLog.create({
        data: {
          teamId,
          action: "E2E_SHARE",
          actorEmail: actor.email,
          actorName: actor.username,
          folderId: folderId || undefined,
          fileName: fileName || `${successfulRecipients.length} fichier(s) partagé(s) E2E`,
        },
      }).catch((err) =>
        this.logger.debug(`Failed to log E2E_SHARE activity: ${err.message}`),
      );
    }

    for (const { recipientUserId } of successfulRecipients) {
      // Find the corresponding grant DTO to get encryptedNotification
      const recipientGrant = dto.grants.find(
        (g) => g.recipientUserId === recipientUserId,
      );
      const encryptedNotification = recipientGrant?.encryptedNotification || null;

      // In-app team notification
      if (teamId) {
        this.teamNotificationService
          .notify({
            type: "FILE_SHARED",
            title: encryptedNotification
              ? "Nouveau partage dans votre équipe"
              : fileName
                ? `${actor.username || actor.email} a partagé "${fileName}"`
                : `${actor.username || actor.email} a partagé un fichier`,
            teamId,
            userId: recipientUserId,
            actorId: actor.id,
            teamFileId: teamFileId || undefined,
            folderId: folderId || undefined,
            metadata: encryptedNotification
              ? undefined
              : {
                  senderName: actor.username || actor.email,
                  fileName: fileName || undefined,
                  shareId: shareId || undefined,
                  highlightFileId: firstGrant?.fileId || teamFileId || undefined,
                },
            encryptedMetadata: encryptedNotification || undefined,
          })
          .catch((err) =>
            this.logger.debug(`Notification failed for ${recipientUserId}: ${err.message}`),
          );
      }

      // Email notification
      if (this.config.get("smtp.enabled")) {
        const recipient = await this.prisma.user.findUnique({
          where: { id: recipientUserId },
          select: { email: true },
        });
        if (recipient?.email) {
          if (teamId) {
            // Team share: generic, zero-knowledge notification without share link.
            // RGPD / E2E: never expose sender name or file name in the email.
            this.emailService
              .sendTeamShareNotificationEmail(
                recipient.email,
                teamName || undefined,
              )
              .catch((err) =>
                this.logger.debug(`Email failed for ${recipient.email}: ${err.message}`),
              );
          } else if (shareId) {
            // Direct share: include share link
            this.emailService
              .sendMailToShareRecipients(
                recipient.email,
                shareId,
                actor,
                fileName || undefined,
              )
              .catch((err) =>
                this.logger.debug(`Email failed for ${recipient.email}: ${err.message}`),
              );
          }
        }
      }
    }
  }

  /**
   * Get my grants (all encrypted DEKs I can decrypt).
   * Optional filters by fileId, teamFileId, or shareId.
   */
  @Get("me")
  @UseGuards(JwtGuard)
  async getMyGrants(
    @GetUser() user: User,
    @Query("fileId") fileId?: string,
    @Query("teamFileId") teamFileId?: string,
    @Query("shareId") shareId?: string,
  ) {
    return this.grantService.getMyGrants(user.id, { fileId, teamFileId, shareId });
  }

  /**
   * Get grant for a specific file (for download/decrypt).
   */
  @Get("file/:fileId")
  @UseGuards(JwtGuard)
  async getGrantForFile(
    @GetUser() user: User,
    @Param("fileId", SafeIdPipe) fileId: string,
  ) {
    return this.grantService.getGrantForFile(user.id, fileId);
  }

  /**
   * Get grant for a specific team file.
   */
  @Get("team-file/:teamFileId")
  @UseGuards(JwtGuard)
  async getGrantForTeamFile(
    @GetUser() user: User,
    @Param("teamFileId", SafeIdPipe) teamFileId: string,
  ) {
    return this.grantService.getGrantForTeamFile(user.id, teamFileId);
  }

  /**
   * Revoke a specific grant.
   */
  @Delete(":grantId")
  @UseGuards(JwtGuard)
  async revokeGrant(
    @GetUser() user: User,
    @Param("grantId", SafeIdPipe) grantId: string,
  ) {
    return this.grantService.revokeGrant(grantId, user.id);
  }

  /**
   * Revoke all grants for a file (before DEK rotation).
   */
  @Delete("file/:fileId/all")
  @UseGuards(JwtGuard)
  async revokeAllForFile(
    @GetUser() user: User,
    @Param("fileId", SafeIdPipe) fileId: string,
  ) {
    return this.grantService.revokeAllGrantsForFile(fileId, user.id);
  }

  /**
   * Revoke all grants for a team file.
   */
  @Delete("team-file/:teamFileId/all")
  @UseGuards(JwtGuard)
  async revokeAllForTeamFile(
    @GetUser() user: User,
    @Param("teamFileId", SafeIdPipe) teamFileId: string,
  ) {
    return this.grantService.revokeAllGrantsForTeamFile(teamFileId, user.id);
  }

  /**
   * Get team shares (received + sent) for the current user in a team.
   */
  @Get("team/:teamId/shares")
  @UseGuards(JwtGuard)
  async getTeamShares(
    @GetUser() user: User,
    @Param("teamId", SafeIdPipe) teamId: string,
    @Query("receivedPage") receivedPage?: string,
    @Query("sentPage") sentPage?: string,
    @Query("limit") limit?: string,
  ) {
    return this.grantService.getTeamShares(user.id, teamId, {
      receivedPage: receivedPage ? Number.parseInt(receivedPage, 10) : undefined,
      sentPage: sentPage ? Number.parseInt(sentPage, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }
}
