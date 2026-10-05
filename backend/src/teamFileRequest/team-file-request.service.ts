import {
  fileRequestServiceEmail,
  fileRequestServiceMessage,
} from "./team-file-request-i18n";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { ConfigService } from "src/config/config.service";
import {
  validateFileRequestEnvelope,
  wantsFileRequestNotification,
} from "./team-file-request-notification";
import { Prisma } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";
import { CreateTeamFileRequestDTO } from "./dto/create-team-file-request.dto";
import { canWriteRequestFolder } from "./team-file-request-access";
import {
  isTeamFileMetaWriteEnabledFor,
  isValidEncryptedFileRequestInfo,
} from "src/file/file-metadata-scheme";

const userSelect = { id: true, username: true, email: true } as const;
const requestInclude = {
  creator: { select: userSelect },
  folder: { select: { id: true, name: true } },
  recipients: { include: { user: { select: userSelect } } },
  shares: {
    where: { hasBeenCompleted: true, files: { some: {} } },
    select: { creatorId: true, _count: { select: { files: true } } },
  },
} satisfies Prisma.TeamFileRequestInclude;

@Injectable()
export class TeamFileRequestService {
  private readonly logger = new Logger(TeamFileRequestService.name);
  constructor(
    private prisma: PrismaService,
    private notifications: TeamNotificationService,
    private outbox: EmailOutboxService,
    private config: ConfigService,
  ) {}

  private async context(
    teamId: string,
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const team = await tx.team.findFirst({
      where: {
        id: teamId,
        isActive: true,
        members: { some: { userId, isActive: true } },
      },
      include: {
        members: {
          where: { isActive: true },
          include: { user: { select: userSelect } },
        },
        sharedFolders: {
          include: { accessRules: true },
          orderBy: { name: "asc" },
        },
      },
    });
    if (!team) throw new NotFoundException("Active team not found");
    return team;
  }

  async options(teamId: string, userId: string) {
    const team = await this.context(teamId, userId);
    const actor = team.members.find((m) => m.userId === userId);
    return team.sharedFolders
      .filter((f) => canWriteRequestFolder(actor, f.accessRules))
      .map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        recipients: team.members
          .filter((m) => m.userId !== userId)
          .map((m) => ({
            ...m.user,
            canUpload: canWriteRequestFolder(m, f.accessRules),
          })),
      }));
  }

  async create(teamId: string, userId: string, dto: CreateTeamFileRequestDTO) {
    const now = new Date();
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(now.getTime() + 30 * 86400000);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= now ||
      expiresAt.getTime() > now.getTime() + 365 * 86400000
    ) {
      throw new BadRequestException(
        "The deadline must be within the next 365 days",
      );
    }
    if (dto.sendEmail && !this.config.get("smtp.enabled"))
      throw new BadRequestException("Email delivery is disabled");
    const result = await this.prisma.$transaction(async (tx) => {
      // Bound open requests per team, including concurrent creators.
      // Acquire the SQLite writer lock before reading or checking the limit.
      await tx.$executeRaw`UPDATE "Team" SET "id" = "id" WHERE "id" = ${teamId}`;
      const team = await this.context(teamId, userId, tx);
      const folder = team.sharedFolders.find((f) => f.id === dto.folderId);
      if (!folder) throw new NotFoundException("Destination folder not found");
      const actor = team.members.find((m) => m.userId === userId);
      if (!canWriteRequestFolder(actor, folder.accessRules))
        throw new ForbiddenException("Write access required");
      // An encrypted subject needs K_team on the requester's side, replaces
      // the readable subject and note, and follows FILE_META_V1_TEAM_WRITE.
      if (dto.encryptedInfo !== undefined) {
        const rotation = await tx.teamKeyRotation.findFirst({
          where: {
            teamId,
            status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
          },
          select: { id: true },
        });
        if (rotation)
          throw new BadRequestException(
            "Encrypted file requests are paused during team key rotation",
          );
        if (
          !actor!.wrappedTeamKey ||
          !isTeamFileMetaWriteEnabledFor(actor!.user)
        )
          throw new BadRequestException("file_request_info_not_allowed");
        if (
          dto.subject ||
          dto.note ||
          !isValidEncryptedFileRequestInfo(dto.encryptedInfo)
        )
          throw new BadRequestException("file_request_info_invalid");
      }
      const recipients =
        dto.recipientScope === "ALL"
          ? team.members.filter((m) => m.userId !== userId).map((m) => m.userId)
          : [...new Set(dto.recipientIds)];
      if (
        !recipients.length ||
        recipients.length > 100 ||
        recipients.some(
          (id) =>
            id === userId ||
            !canWriteRequestFolder(
              team.members.find((m) => m.userId === id),
              folder.accessRules,
            ),
        )
      ) {
        throw new BadRequestException(
          "Recipients must be active team members with write access to the destination",
        );
      }
      const openCount = await tx.teamFileRequest.count({
        where: { teamId, status: "OPEN", expiresAt: { gt: now } },
      });
      if (openCount >= 100)
        throw new BadRequestException(
          "Close an existing request before creating another",
        );
      const notificationByUser = new Map(
        dto.notifications.map((n) => [n.userId, n.encryptedMetadata]),
      );
      if (
        notificationByUser.size !== dto.notifications.length ||
        dto.notifications.some((n) => !recipients.includes(n.userId))
      ) {
        throw new BadRequestException("Invalid notification recipients");
      }
      const notifiable = team.members.filter(
        (m) =>
          recipients.includes(m.userId) &&
          wantsFileRequestNotification(m.pushNotifMode),
      );
      for (const m of notifiable)
        validateFileRequestEnvelope(notificationByUser.get(m.userId));
      if (dto.submissionNotification)
        validateFileRequestEnvelope(dto.submissionNotification);
      if (
        wantsFileRequestNotification(actor!.pushNotifMode) &&
        !dto.submissionNotification
      ) {
        throw new BadRequestException(
          "An encrypted deposit notification is required",
        );
      }
      const request = await tx.teamFileRequest.create({
        data: {
          id: dto.id,
          teamId,
          creatorId: userId,
          folderId: folder.id,
          subject: dto.encryptedInfo ? "" : dto.subject,
          note: dto.encryptedInfo ? null : dto.note || null,
          encryptedInfo: dto.encryptedInfo || null,
          recipientScope: dto.recipientScope,
          sendEmail: !!dto.sendEmail,
          submissionNotification: dto.submissionNotification || null,
          expiresAt,
          recipients: { create: recipients.map((id) => ({ userId: id })) },
        },
      });
      const notifications = notifiable.length
        ? await tx.teamNotification.createManyAndReturn({
            data: notifiable.map((m) => ({
              userId: m.userId,
              actorId: userId,
              teamId,
              type: "FILE_REQUESTED",
              title: fileRequestServiceMessage("request"),
              encryptedMetadata: notificationByUser.get(m.userId)!,
              metadata: null,
            })),
          })
        : [];
      if (dto.sendEmail) {
        const url = new URL(
          `/team/${teamId}?fileRequests=1`,
          this.config.get("general.appUrl"),
        );
        for (const recipientId of recipients) {
          const recipient = team.members.find((m) => m.userId === recipientId)!;
          await this.outbox.enqueue(
            tx,
            {
              recipient: recipient.user.email,
              ...fileRequestServiceEmail(url.toString()),
              expiresAt: expiresAt.toISOString(),
            },
            `team-file-request:${request.id}:${recipientId}`,
          );
        }
      }
      await tx.teamAccessLog.create({
        data: {
          teamId,
          folderId: folder.id,
          action: "FILE_REQUEST_CREATE",
          actorEmail: actor!.user.email,
          targetType: "FILE_REQUEST",
          targetId: request.id,
        },
      });
      return { request, notifications };
    });
    for (const notification of result.notifications)
      this.notifications.deliverFileRequestNotification(notification);
    if (dto.sendEmail)
      void this.outbox
        .deliverPending()
        .catch(() => this.logger.debug("File request email delivery deferred"));
    return { id: result.request.id };
  }

  async list(teamId: string, userId: string, offset = 0) {
    const team = await this.context(teamId, userId);
    const member = team.members.find((m) => m.userId === userId);
    const visibleFolderIds = team.sharedFolders
      .filter((f) => canWriteRequestFolder(member, f.accessRules))
      .map((f) => f.id);
    const where: Prisma.TeamFileRequestWhereInput = {
      teamId,
      AND: [
        {
          OR: [
            { creatorId: userId },
            {
              recipients: { some: { userId } },
              folderId: { in: visibleFolderIds },
            },
          ],
        },
      ],
    };
    const requests = await this.prisma.teamFileRequest.findMany({
      where,
      include: requestInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: 25,
    });
    return {
      requests: requests.map((r) => this.serialize(r, userId, team)),
      total: await this.prisma.teamFileRequest.count({ where }),
    };
  }

  async get(teamId: string, requestId: string, userId: string) {
    const team = await this.context(teamId, userId);
    const request = await this.prisma.teamFileRequest.findFirst({
      where: {
        id: requestId,
        teamId,
        OR: [{ creatorId: userId }, { recipients: { some: { userId } } }],
      },
      include: requestInclude,
    });
    if (!request) throw new NotFoundException("File request not found");
    const result = this.serialize(request, userId, team);
    if (request.creatorId !== userId && !result.canWrite)
      throw new NotFoundException("File request not found");
    return result;
  }

  private serialize(
    request: Prisma.TeamFileRequestGetPayload<{
      include: typeof requestInclude;
    }>,
    userId: string,
    team: Awaited<ReturnType<TeamFileRequestService["context"]>>,
  ) {
    const folder = team.sharedFolders.find((f) => f.id === request.folderId);
    const canWrite =
      !!folder &&
      canWriteRequestFolder(
        team.members.find((m) => m.userId === userId),
        folder.accessRules,
      );
    const creatorCanWrite =
      !!folder &&
      canWriteRequestFolder(
        team.members.find((m) => m.userId === request.creatorId),
        folder.accessRules,
      );
    const {
      shares,
      recipients,
      submissionNotification: _notification,
      ...rest
    } = request;
    const status =
      request.status === "OPEN" && request.expiresAt <= new Date()
        ? "EXPIRED"
        : request.status;
    return {
      ...rest,
      status,
      canWrite,
      canRespond:
        status === "OPEN" &&
        canWrite &&
        creatorCanWrite &&
        recipients.some((r) => r.userId === userId),
      recipients: (request.creatorId === userId
        ? recipients
        : recipients.filter((r) => r.userId === userId)
      ).map((r) => ({
        user: r.user,
        fileCount: shares
          .filter((s) => s.creatorId === r.userId)
          .reduce((n, s) => n + s._count.files, 0),
      })),
    };
  }

  @Cron("0 3 * * *")
  async cleanup() {
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const expired = await this.prisma.teamFileRequest.findMany({
      where: {
        OR: [
          { expiresAt: { lt: cutoff } },
          { status: "CLOSED", closedAt: { lt: cutoff } },
        ],
      },
      select: { id: true },
      take: 1000,
    });
    if (expired.length)
      await this.prisma.teamFileRequest.deleteMany({
        where: { id: { in: expired.map((r) => r.id) } },
      });
  }

  async close(teamId: string, requestId: string, userId: string) {
    await this.context(teamId, userId);
    const result = await this.prisma.teamFileRequest.updateMany({
      where: { id: requestId, teamId, creatorId: userId, status: "OPEN" },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    if (!result.count)
      throw new NotFoundException("Open file request not found");
    return { closed: true };
  }
}
