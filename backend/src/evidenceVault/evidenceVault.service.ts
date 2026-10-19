import {
  ConflictException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { AccountPasskeyService } from "src/passkey/accountPasskey.service";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamExternalAuditService } from "src/teamExternal/team-external-audit.service";
import { IssuanceManifest } from "src/teamExternal/team-external-audit.util";

// The vault keeps the register and journal of contractor copies reachable for
// the audit retention, even once the team or its administrators are gone.
// Platform administrators open it with a passkey for a few minutes, every
// extraction is written into the journal of the copy it concerns.
export const EVIDENCE_VAULT_TTL_MS = 10 * 60 * 1000;
export const EVIDENCE_VAULT_COOKIE = "evidence_vault";
export const EVIDENCE_VAULT_COOKIE_PATH = "/api/admin/evidence-vault";

const SESSION_VALUE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TEAMS = 100;
const MAX_SEARCH = 100;

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

@Injectable()
export class EvidenceVaultService {
  private readonly logger = new Logger(EvidenceVaultService.name);

  constructor(
    private prisma: PrismaService,
    private passkeys: AccountPasskeyService,
    private audit: TeamExternalAuditService,
  ) {}

  // ===========================================================================
  // ACCESS
  // ===========================================================================

  beginUnlock(user: User) {
    return this.passkeys.beginVault(user);
  }

  /** Opens the vault for this administrator, replacing any earlier opening. */
  async unlock(user: User, dto: PasskeyResponseDTO) {
    await this.passkeys.verifyVault(user, dto);
    await this.prisma.evidenceVaultSession.deleteMany({
      where: {
        OR: [{ userId: user.id }, { expiresAt: { lt: new Date() } }],
      },
    });
    const value = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + EVIDENCE_VAULT_TTL_MS);
    await this.prisma.evidenceVaultSession.create({
      data: { sessionHash: digest(value), userId: user.id, expiresAt },
    });
    this.logger.warn(`EVIDENCE_VAULT: opened by platform admin ${user.id}`);
    return { value, expiresAt };
  }

  /** When the vault closes for this administrator, or null if it is shut. */
  async openUntil(value: unknown, user: User) {
    if (typeof value !== "string" || !SESSION_VALUE.test(value)) return null;
    const session = await this.prisma.evidenceVaultSession.findUnique({
      where: { sessionHash: digest(value) },
    });
    if (
      !session ||
      session.userId !== user.id ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    return session.expiresAt;
  }

  async lock(user: User) {
    await this.prisma.evidenceVaultSession.deleteMany({
      where: { userId: user.id },
    });
  }

  // ===========================================================================
  // CONTENT
  // ===========================================================================

  /**
   * Teams holding register entries, most recent first, whether they still
   * exist or not. The search matches an address, a team name or an id.
   */
  async teams(search?: string) {
    const query = typeof search === "string" ? search.trim() : "";
    if (query.length > MAX_SEARCH) {
      throw new BadRequestException("Search is too long");
    }
    const where: Prisma.TeamExternalIssuanceWhereInput = {
      status: "ISSUED",
      ...(query
        ? {
            OR: [
              { teamId: query },
              { contractorEmail: { contains: query } },
              { issuerEmail: { contains: query } },
              { manifest: { contains: query } },
            ],
          }
        : {}),
    };
    const matched = await this.prisma.teamExternalIssuance.groupBy({
      by: ["teamId"],
      where,
      _max: { issuedAt: true },
      orderBy: { _max: { issuedAt: "desc" } },
      take: MAX_TEAMS,
    });
    const ids = matched.map((group) => group.teamId);
    if (ids.length === 0) return [];
    const [counts, latest, existing] = await Promise.all([
      this.prisma.teamExternalIssuance.groupBy({
        by: ["teamId"],
        where: { teamId: { in: ids }, status: "ISSUED" },
        _count: { _all: true },
      }),
      this.prisma.teamExternalIssuance.findMany({
        where: { teamId: { in: ids }, status: "ISSUED" },
        orderBy: { issuedAt: "desc" },
        distinct: ["teamId"],
        select: { teamId: true, manifest: true },
      }),
      this.prisma.team.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      }),
    ]);
    const countOf = new Map(
      counts.map((group) => [group.teamId, group._count._all]),
    );
    const recordedName = new Map(
      latest.map((issuance) => [
        issuance.teamId,
        (JSON.parse(issuance.manifest) as IssuanceManifest).team.name,
      ]),
    );
    const liveName = new Map(existing.map((team) => [team.id, team.name]));
    return matched.map((group) => ({
      teamId: group.teamId,
      teamName:
        liveName.get(group.teamId) ?? recordedName.get(group.teamId) ?? "",
      teamExists: liveName.has(group.teamId),
      copies: countOf.get(group.teamId) ?? 0,
      lastIssuedAt: group._max.issuedAt,
    }));
  }

  issuances(teamId: string) {
    return this.audit.issuancesOf(teamId);
  }

  async certificate(teamId: string, issuanceId: string, admin: User) {
    await this.recordExtraction(teamId, issuanceId, admin);
    return this.audit.certificateOf(teamId, issuanceId);
  }

  async evidence(teamId: string, issuanceId: string, admin: User) {
    await this.recordExtraction(teamId, issuanceId, admin);
    return this.audit.bundleOf(teamId, issuanceId);
  }

  async journal(teamId: string, issuanceId: string, admin: User) {
    const previewId = await this.recordExtraction(teamId, issuanceId, admin);
    return this.audit.journalOf(teamId, previewId);
  }

  /**
   * Every extraction leaves a trace in the journal of the copy, before
   * anything is returned: the customer and any auditor see it.
   */
  private async recordExtraction(
    teamId: string,
    issuanceId: string,
    admin: User,
  ) {
    const issuance = await this.prisma.teamExternalIssuance.findFirst({
      where: { id: issuanceId, teamId, status: "ISSUED" },
      select: { previewId: true },
    });
    if (!issuance) throw new NotFoundException("Register entry not found");
    await this.audit.appendEvent({
      teamId,
      kind: "VAULT",
      actorEmail: admin.email,
      previewId: issuance.previewId,
    });
    this.logger.warn(
      `EVIDENCE_VAULT: register entry ${issuanceId} of team ${teamId} extracted by platform admin ${admin.id}`,
    );
    return issuance.previewId;
  }

  /**
   * Erases the evidence of a deleted team before the retention ends, on the
   * written instruction of the customer. The exact team name confirms it.
   */
  async erase(teamId: string, confirmation: string, admin: User) {
    if (await this.prisma.team.findUnique({ where: { id: teamId } })) {
      throw new ConflictException(
        "The team still exists: its evidence follows the retention",
        "vault_team_exists",
      );
    }
    const team = (await this.teams(teamId)).find(
      (candidate) => candidate.teamId === teamId,
    );
    if (!team) {
      throw new NotFoundException("No evidence for this team");
    }
    if (confirmation !== team.teamName) {
      throw new BadRequestException(
        "Type the exact team name to confirm",
        "vault_confirmation_mismatch",
      );
    }
    const erased = await this.audit.eraseTeam(teamId);
    this.logger.warn(
      `EVIDENCE_VAULT: evidence of deleted team ${teamId} erased by platform admin ${admin.id} (${erased.issuances} entries, ${erased.events} events, ${erased.anchors} anchors)`,
    );
    return erased;
  }
}
