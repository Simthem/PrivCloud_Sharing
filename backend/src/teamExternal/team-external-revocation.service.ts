import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { User } from "@prisma/client";
import { ConfigService } from "src/config/config.service";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";

export type RevocationReminderMode = "NONE" | "EMAIL" | "PUSH" | "BOTH";
const MODES = ["NONE", "EMAIL", "PUSH", "BOTH"];
const TITLE = "Accès prestataire terminé / Contractor access ended";
const BODY =
  "Ouvrez le registre pour conserver les preuves / Open the register to retain the evidence";

@Injectable()
export class TeamExternalRevocationService {
  private readonly logger = new Logger(TeamExternalRevocationService.name);
  private running = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private email: EmailOutboxService,
    private notifications: TeamNotificationService,
  ) {}

  private async assertAdmin(teamId: string, userId: string) {
    const admin = await this.prisma.teamMember.findFirst({
      where: {
        teamId,
        userId,
        isActive: true,
        role: { in: ["OWNER", "ADMIN"] },
        team: { isActive: true },
      },
      select: { id: true },
    });
    if (!admin)
      throw new ForbiddenException("An active team administrator is required");
  }

  async preferences(teamId: string, user: User) {
    await this.assertAdmin(teamId, user.id);
    return this.prisma.teamExternalRevocationWatch.findMany({
      where: { userId: user.id, seat: { teamId } },
      select: { seatId: true, mode: true },
    });
  }

  async setPreference(
    teamId: string,
    seatId: string,
    user: User,
    mode: RevocationReminderMode,
  ) {
    if (!MODES.includes(mode))
      throw new BadRequestException("Invalid reminder mode");
    await this.assertAdmin(teamId, user.id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "TeamExternalSeat" SET "id" = "id" WHERE "id" = ${seatId} AND "teamId" = ${teamId}`;
      const seat = await tx.teamExternalSeat.findFirst({
        where: { id: seatId, teamId },
        select: { id: true },
      });
      if (!seat) throw new NotFoundException("Seat not found");
      await tx.teamExternalRevocationWatch.upsert({
        where: { seatId_userId: { seatId, userId: user.id } },
        create: { seatId, userId: user.id, mode },
        update: { mode },
      });
      return { mode };
    });
  }

  @Interval(60_000)
  async scheduledReminders() {
    await this.notifyEndedAccess();
  }

  /** The denial of access never depends on mail, Web Push or this worker. */
  async notifyEndedAccess(teamId?: string, seatId?: string, now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.prisma.teamExternalRevocationWatch.findMany({
        where: {
          notifiedAt: null,
          mode: { in: ["EMAIL", "PUSH", "BOTH"] },
          ...(seatId ? { seatId } : {}),
          seat: {
            ...(teamId ? { teamId } : {}),
            team: { isActive: true },
            OR: [{ status: "REVOKED" }, { accessExpiresAt: { lte: now } }],
          },
        },
        orderBy: { createdAt: "asc" },
        take: 100,
        select: { id: true, seatId: true },
      });
      for (const candidate of pending) {
        try {
          const notification = await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`UPDATE "TeamExternalSeat" SET "id" = "id" WHERE "id" = ${candidate.seatId}`;
            const watch = await tx.teamExternalRevocationWatch.findUnique({
              where: { id: candidate.id },
              include: { seat: true, user: { select: { email: true } } },
            });
            if (
              !watch ||
              watch.notifiedAt ||
              !MODES.includes(watch.mode) ||
              watch.mode === "NONE"
            )
              return null;
            const seat = watch.seat;
            if (seat.status !== "REVOKED" && seat.accessExpiresAt > now)
              return null;
            const admin = await tx.teamMember.findFirst({
              where: {
                teamId: seat.teamId,
                userId: watch.userId,
                isActive: true,
                role: { in: ["OWNER", "ADMIN"] },
                team: { isActive: true },
              },
              select: { id: true },
            });
            if (!admin) {
              await tx.teamExternalRevocationWatch.update({
                where: { id: watch.id },
                data: { mode: "NONE" },
              });
              return null;
            }
            const claimed = await tx.teamExternalRevocationWatch.updateMany({
              where: { id: watch.id, notifiedAt: null, mode: watch.mode },
              data: { notifiedAt: now },
            });
            if (claimed.count !== 1) return null;
            if (watch.mode === "EMAIL" || watch.mode === "BOTH") {
              const origin = new URL(
                this.config.get("general.appUrl") as string,
              );
              if (
                origin.protocol !== "https:" ||
                origin.username ||
                origin.password
              )
                throw new Error("A secure application URL is required");
              const url = new URL(
                `/team/${encodeURIComponent(seat.teamId)}/settings#external-contractors`,
                origin,
              ).href;
              const endedAt =
                seat.status === "REVOKED"
                  ? (seat.revokedAt ?? now)
                  : seat.accessExpiresAt;
              await this.email.enqueue(
                tx,
                {
                  recipient: watch.user.email,
                  subject: TITLE,
                  text: `Bonjour,\n\nL'accès du prestataire ${seat.email} a pris fin le ${endedAt.toISOString()}. Ce rappel concerne cette fin d'accès. Consultez le registre pour vérifier l'état actuel, notamment si un nouvel accès a été accordé depuis.\n\nConservez les certificats et dossiers de preuve depuis le registre. Leur téléchargement exige la passkey d'un administrateur actif de l'équipe. Une révocation n'efface pas les captures déjà obtenues.\n\n${url}\n\nHello,\n\nContractor ${seat.email}'s access ended at ${endedAt.toISOString()}. This reminder concerns that access ending. Check the register for the current state, especially if access has since been granted again.\n\nRetain certificates and evidence archives from the register. Downloading requires an active team administrator's passkey. Revocation does not erase previously obtained captures.\n\n${url}`,
                },
                `external-access-ended:${watch.id}:${endedAt.toISOString()}`,
              );
            }
            if (watch.mode !== "PUSH" && watch.mode !== "BOTH") return null;
            return tx.teamNotification.create({
              data: {
                type: "EXTERNAL_ACCESS_ENDED",
                title: TITLE,
                teamId: seat.teamId,
                userId: watch.userId,
                metadata: JSON.stringify({ externalSeatId: seat.id }),
              },
              select: { id: true, teamId: true, userId: true, title: true },
            });
          });
          if (notification)
            this.notifications.deliverExternalRevocationNotification(
              notification,
              BODY,
            );
        } catch {
          this.logger.warn("Could not queue an external-access reminder");
        }
      }
      void this.email.deliverPending().catch(() => {
        this.logger.warn("External-access email delivery remains queued");
      });
    } catch {
      this.logger.warn("Could not inspect external-access reminders");
    } finally {
      this.running = false;
    }
  }
}
