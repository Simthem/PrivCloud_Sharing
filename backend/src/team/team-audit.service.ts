import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import {
  buildTeamAuditSummary,
  getScheduledAuditWindow,
  TeamAuditSummary,
} from "./team-audit.util";

@Injectable()
export class TeamAuditService {
  private readonly logger = new Logger(TeamAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async dispatchScheduledReports(now = new Date()) {
    const teams = await this.prisma.team.findMany({
      where: { isActive: true, reportEnabled: true },
      select: { id: true, reportFrequency: true },
    });

    let sent = 0;
    for (const team of teams) {
      const window = getScheduledAuditWindow(team.reportFrequency, now);
      if (!window) continue;
      try {
        const report = await this.generateAndSend(
          team.id,
          team.reportFrequency,
          window.start,
          window.end,
        );
        if (report.status === "SENT") sent++;
      } catch (error) {
        this.logger.error(
          `Team audit report failed for ${team.id}: ${(error as Error).message}`,
        );
      }
    }
    return { eligible: teams.length, sent };
  }

  async listReports(teamId: string, userId: string) {
    await this.assertTeamAdmin(teamId, userId);
    const reports = await this.prisma.teamAuditReport.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: 24,
    });
    return reports.map((report) => ({
      ...report,
      summary: this.parseSummary(report.summary),
      recipientEmails: this.parseStringArray(report.recipientEmails),
    }));
  }

  async sendNow(teamId: string, userId: string) {
    await this.assertTeamAdmin(teamId, userId);
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86_400_000);
    return this.generateAndSend(teamId, "MANUAL", start, end);
  }

  private async generateAndSend(
    teamId: string,
    frequency: string,
    periodStart: Date,
    periodEnd: Date,
  ) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        members: {
          where: { isActive: true },
          include: {
            user: { select: { email: true, username: true } },
          },
        },
      },
    });
    if (!team) throw new NotFoundException("Team not found");

    const existing = await this.prisma.teamAuditReport.findUnique({
      where: {
        teamId_frequency_periodStart_periodEnd: {
          teamId,
          frequency,
          periodStart,
          periodEnd,
        },
      },
    });
    if (existing?.status === "SENT") return existing;

    const logs = await this.prisma.teamAccessLog.findMany({
      where: {
        teamId,
        createdAt: { gte: periodStart, lt: periodEnd },
      },
      select: {
        action: true,
        actorEmail: true,
        fileName: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const keyHealth = team.members.reduce(
      (health, member) => {
        if (
          member.wrappedTeamKey &&
          member.teamKeyVersion === team.keyVersion
        ) {
          health.current++;
        } else if (member.teamKeyVersion > 0) {
          health.pending++;
        } else {
          health.missing++;
        }
        return health;
      },
      { current: 0, pending: 0, missing: 0 },
    );
    const summary = buildTeamAuditSummary(logs, keyHealth);
    const recipients = [
      ...new Set(
        team.members
          .filter((member) => ["OWNER", "ADMIN"].includes(member.role))
          .map((member) => member.user.email),
      ),
    ];

    let report = await this.prisma.teamAuditReport.upsert({
      where: {
        teamId_frequency_periodStart_periodEnd: {
          teamId,
          frequency,
          periodStart,
          periodEnd,
        },
      },
      create: {
        teamId,
        frequency,
        periodStart,
        periodEnd,
        summary: JSON.stringify(summary),
        recipientEmails: JSON.stringify(recipients),
      },
      update: {
        summary: JSON.stringify(summary),
        recipientEmails: JSON.stringify(recipients),
        status: "GENERATED",
        error: null,
      },
    });

    if (recipients.length === 0) {
      return this.prisma.teamAuditReport.update({
        where: { id: report.id },
        data: { status: "FAILED", error: "No active Team administrator" },
      });
    }

    const subject = `[${team.name}] Rapport d'audit ${this.frequencyLabel(frequency)}`;
    const body = this.formatEmail(team.name, periodStart, periodEnd, summary);
    const failures: string[] = [];
    for (const recipient of recipients) {
      try {
        await this.emailService.sendMail(recipient, subject, body);
      } catch (error) {
        failures.push(`${recipient}: ${(error as Error).message}`);
      }
    }

    report = await this.prisma.teamAuditReport.update({
      where: { id: report.id },
      data:
        failures.length === 0
          ? { status: "SENT", sentAt: new Date(), error: null }
          : { status: "FAILED", error: failures.join(" | ").slice(0, 2000) },
    });
    return report;
  }

  private formatEmail(
    teamName: string,
    start: Date,
    end: Date,
    summary: TeamAuditSummary,
  ) {
    const t = summary.totals;
    const lines = [
      `Rapport d'audit de l'équipe ${teamName}`,
      `Période : ${start.toLocaleDateString("fr-FR")} - ${end.toLocaleDateString("fr-FR")}`,
      "",
      `Événements : ${t.events}`,
      `Uploads : ${t.uploads}`,
      `Téléchargements : ${t.downloads}`,
      `Partages E2E / liens invités : ${t.e2eShares}`,
      `Suppressions : ${t.deletions}`,
      `Changements de permissions : ${t.permissionChanges}`,
      `Invitations : ${t.invitations}`,
      `Membres ajoutés / retirés : ${t.membersAdded} / ${t.membersRemoved}`,
      `Rotations de clé : ${t.keyRotations}`,
      `Liens invités créés / révoqués : ${t.guestLinksCreated} / ${t.guestLinksRevoked}`,
      "",
      `Clés Team : ${summary.keyHealth.current} à jour, ${summary.keyHealth.pending} en attente, ${summary.keyHealth.missing} manquante(s)`,
      "",
      summary.anomalies.length > 0
        ? `Points d'attention :\n${summary.anomalies.map((a) => `- ${a.description}`).join("\n")}`
        : "Aucune anomalie détectée selon les seuils automatiques.",
      "",
      "Ce rapport ne contient ni contenu de fichier ni clé de chiffrement.",
    ];
    return lines.join("\n");
  }

  private frequencyLabel(frequency: string) {
    if (frequency === "MONTHLY") return "mensuel";
    if (frequency === "WEEKLY") return "hebdomadaire";
    if (frequency === "DAILY") return "quotidien";
    return "à la demande";
  }

  private async assertTeamAdmin(teamId: string, userId: string) {
    const member = await this.prisma.teamMember.findFirst({
      where: {
        teamId,
        userId,
        isActive: true,
        role: { in: ["OWNER", "ADMIN"] },
      },
    });
    if (!member) {
      throw new ForbiddenException("Only Team owners and admins can access audit reports");
    }
  }

  private parseSummary(value: string): TeamAuditSummary | null {
    try {
      return JSON.parse(value) as TeamAuditSummary;
    } catch {
      return null;
    }
  }

  private parseStringArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
}
