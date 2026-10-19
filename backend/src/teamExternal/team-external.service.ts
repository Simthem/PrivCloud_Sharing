import { accountEmailExists } from "src/user/account-email.util";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { randomBytes } from "crypto";
import { ConfigService } from "src/config/config.service";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import { sha256Hex } from "src/signing/signing-evidence.util";
import {
  CreateExternalPreviewDTO,
  InviteExternalSeatDTO,
  UpdateExternalSeatDTO,
} from "./dto/team-external.dto";
import {
  displayedSeatStatus,
  EXTERNAL_INVITE_TTL_MS,
  EXTERNAL_PAGE_MAX_BYTES,
  EXTERNAL_PAGE_MIN_BYTES,
  EXTERNAL_PREVIEWS_PER_SEAT,
  EXTERNAL_SEAT_HISTORY_MS,
  EXTERNAL_SEAT_LIMIT,
  EXTERNAL_UPLOAD_TTL_MS,
  externalPreviewPageKey,
  hashExternalToken,
  isBase64UrlWithin,
  isSeatUsable,
  isValidHybridWrapping,
  parseAccessExpiry,
  seatTakesPlace,
} from "./team-external.util";
import { TeamExternalAuditService } from "./team-external-audit.service";

const ADMIN_ROLES = ["OWNER", "ADMIN"];

// Every refusal on the contractor side is the same 404: it never tells
// whether a preview exists, belongs to someone else, expired or was revoked.
const notFound = () => new NotFoundException("Preview not found");

@Injectable()
export class TeamExternalService {
  private readonly logger = new Logger(TeamExternalService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private fileService: FileService,
    private emailOutbox: EmailOutboxService,
    private audit: TeamExternalAuditService,
  ) {}

  // ===========================================================================
  // TEAM ADMIN SIDE
  // ===========================================================================

  private async assertTeamAdmin(teamId: string, user: User) {
    const member = await this.prisma.teamMember.findFirst({
      where: {
        teamId,
        userId: user.id,
        isActive: true,
        role: { in: ADMIN_ROLES },
        team: { isActive: true },
      },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException(
        "Only an administrator of an active team can manage external contractors",
      );
    }
  }

  private seatView(
    seat: Prisma.TeamExternalSeatGetPayload<{
      include: { _count: { select: { previews: true } } };
    }>,
    now: Date,
  ) {
    return {
      id: seat.id,
      email: seat.email,
      displayName: seat.displayName,
      status: displayedSeatStatus(seat, now),
      inviteExpiresAt: seat.inviteExpiresAt,
      accessExpiresAt: seat.accessExpiresAt,
      acceptedAt: seat.acceptedAt,
      revokedAt: seat.revokedAt,
      previewCount: seat._count.previews,
    };
  }

  async listSeats(teamId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    const now = new Date();
    const seats = await this.prisma.teamExternalSeat.findMany({
      where: { teamId },
      include: {
        _count: { select: { previews: { where: { deletedAt: null } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      limit: EXTERNAL_SEAT_LIMIT,
      used: seats.filter((seat) => seatTakesPlace(seat, now)).length,
      seats: seats.map((seat) => this.seatView(seat, now)),
    };
  }

  async inviteSeat(teamId: string, user: User, dto: InviteExternalSeatDTO) {
    await this.assertTeamAdmin(teamId, user);
    const now = new Date();
    const email = dto.email.trim().toLowerCase();
    const accessExpiresAt = parseAccessExpiry(dto.accessExpiresAt, now);

    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, isActive: true, user: { email } },
      select: { id: true },
    });
    if (member) {
      throw new ConflictException(
        "This address belongs to a member of the team",
      );
    }
    const pendingMember = await this.prisma.teamInvitation.findFirst({
      where: {
        teamId,
        email,
        status: "PENDING",
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (pendingMember) {
      throw new ConflictException(
        "A member invitation is pending for this address",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const inviteExpiresAt = new Date(
      Math.min(
        now.getTime() + EXTERNAL_INVITE_TTL_MS,
        accessExpiresAt.getTime(),
      ),
    );
    const appUrl = this.config.get("general.appUrl");
    const appName = this.config.get("general.appName") || "PrivCloud";
    const inviteUrl = `${appUrl}/external/invite/${token}`;

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    const seat = await this.prisma.$transaction(async (tx) => {
      // Serialize invitations of one team so two admins cannot both take the
      // last place.
      await tx.$executeRaw`UPDATE "Team" SET "id" = "id" WHERE "id" = ${teamId}`;
      const seats = await tx.teamExternalSeat.findMany({ where: { teamId } });
      const existing = seats.find((seat) => seat.email === email);
      if (existing && isSeatUsable(existing, now)) {
        throw new ConflictException(
          "This contractor already has an active access",
        );
      }
      const taken = seats.filter(
        (seat) => seat.email !== email && seatTakesPlace(seat, now),
      ).length;
      if (EXTERNAL_SEAT_LIMIT > 0 && taken >= EXTERNAL_SEAT_LIMIT) {
        throw new BadRequestException(
          `The team already uses its ${EXTERNAL_SEAT_LIMIT} external contractor seats`,
        );
      }
      if (existing) {
        // A new invitation starts over: nothing rendered for the previous
        // access may be shown again.
        await tx.teamExternalPreview.updateMany({
          where: { seatId: existing.id, deletedAt: null },
          data: { deletedAt: now },
        });
      }
      const data = {
        displayName: dto.displayName || null,
        status: "PENDING",
        tokenHash: hashExternalToken(token),
        inviteExpiresAt,
        accessExpiresAt,
        acceptedAt: null,
        revokedAt: null,
        invitedById: user.id,
        userId: null,
      };
      const written = await tx.teamExternalSeat.upsert({
        where: { teamId_email: { teamId, email } },
        create: { ...data, teamId, email },
        update: data,
      });
      await tx.teamExternalRevocationWatch.updateMany({
        where: { seatId: written.id },
        data: { notifiedAt: null },
      });
      await this.emailOutbox.enqueue(
        tx,
        {
          recipient: email,
          subject: `Accès en consultation à des documents - ${appName}`,
          text:
            `Bonjour,\n\n` +
            `L'équipe ${team?.name ?? appName} vous donne accès, en consultation seule, à des documents sur ${appName}.\n\n` +
            `Pour accepter l'invitation, connectez-vous ou créez un compte avec cette adresse e-mail, activez la double authentification, puis ouvrez ce lien :\n${inviteUrl}\n\n` +
            `L'invitation expire le ${inviteExpiresAt.toLocaleDateString("fr-FR")}. L'accès prend fin le ${accessExpiresAt.toLocaleDateString("fr-FR")}.\n\n` +
            `-- \n${appName}\n\n` +
            `Hello,\n\n` +
            `The team ${team?.name ?? appName} gives you view-only access to documents on ${appName}.\n\n` +
            `To accept, sign in or create an account with this e-mail address, turn on two-factor authentication, then open this link:\n${inviteUrl}\n\n` +
            `The invitation expires on ${inviteExpiresAt.toLocaleDateString("en-GB")}. The access ends on ${accessExpiresAt.toLocaleDateString("en-GB")}.`,
          expiresAt: inviteExpiresAt.toISOString(),
        },
        `team-external-seat:${written.id}:${written.tokenHash}`,
      );
      return written;
    });

    await this.emailOutbox.deliverPending();
    await this.logAccess(teamId, user, "EXTERNAL_INVITE", { fileName: email });
    void this.purgeHiddenPreviews();

    return { seatId: seat.id, inviteUrl };
  }

  async updateSeat(
    teamId: string,
    seatId: string,
    user: User,
    dto: UpdateExternalSeatDTO,
  ) {
    await this.assertTeamAdmin(teamId, user);
    const now = new Date();
    const accessExpiresAt = parseAccessExpiry(dto.accessExpiresAt, now);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.teamExternalSeat.updateMany({
        where: { id: seatId, teamId, status: { in: ["PENDING", "ACTIVE"] } },
        data: { accessExpiresAt },
      });
      if (updated.count !== 1) throw new NotFoundException("Seat not found");
      await tx.teamExternalRevocationWatch.updateMany({
        where: { seatId },
        data: { notifiedAt: null },
      });
    });
    return { accessExpiresAt };
  }

  async revokeSeat(teamId: string, seatId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    const now = new Date();
    const seat = await this.prisma.teamExternalSeat.findFirst({
      where: { id: seatId, teamId },
      select: { email: true },
    });
    if (!seat) throw new NotFoundException("Seat not found");
    await this.prisma.$transaction([
      this.prisma.teamExternalSeat.update({
        where: { id: seatId },
        data: { status: "REVOKED", revokedAt: now, tokenHash: null },
      }),
      this.prisma.teamExternalPreview.updateMany({
        where: { seatId, deletedAt: null },
        data: { deletedAt: now },
      }),
    ]);
    await this.logAccess(teamId, user, "EXTERNAL_REVOKE", {
      fileName: seat.email,
    });
    await this.audit.appendEvent({
      teamId,
      kind: "REVOKED",
      actorEmail: user.email,
      seatId,
    });
    void this.purgeHiddenPreviews();
    return { revoked: true };
  }

  /** Public keys the admin wraps a preview key for. Hybrid keys only. */
  async getSeatRecipientKeys(teamId: string, seatId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    const seat = await this.prisma.teamExternalSeat.findFirst({
      where: { id: seatId, teamId },
      include: { user: { select: { username: true } } },
    });
    if (!seat || !isSeatUsable(seat, new Date())) {
      throw new NotFoundException("Seat not found");
    }
    const [x25519, pqKey] = await Promise.all([
      this.prisma.userIdentityKey.findFirst({
        where: { userId: seat.userId!, keyType: "X25519", isActive: true },
        orderBy: { version: "desc" },
        select: { publicKey: true, version: true },
      }),
      this.prisma.userPQKey.findFirst({
        where: { userId: seat.userId!, isActive: true, variant: "ML-KEM-768" },
        orderBy: { version: "desc" },
        select: { publicKey: true, variant: true, version: true },
      }),
    ]);
    if (!x25519 || !pqKey) {
      throw new ConflictException(
        "The contractor has no post-quantum encryption keys yet",
        "external_keys_missing",
      );
    }
    return {
      seatId: seat.id,
      email: seat.email,
      displayName: seat.displayName || seat.user?.username || seat.email,
      accessExpiresAt: seat.accessExpiresAt,
      x25519,
      pqKey,
    };
  }

  async listPreviews(teamId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    const previews = await this.prisma.teamExternalPreview.findMany({
      where: { teamId, deletedAt: null, sourceFileId: { not: null } },
      select: {
        id: true,
        seatId: true,
        sourceFileId: true,
        sourceFile: { select: { shareId: true } },
        pageCount: true,
        status: true,
        createdAt: true,
        createdById: true,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return previews.map(({ sourceFile, ...preview }) => ({
      ...preview,
      sourceShareId: sourceFile?.shareId ?? null,
    }));
  }

  async createPreview(
    teamId: string,
    user: User,
    dto: CreateExternalPreviewDTO,
  ) {
    await this.assertTeamAdmin(teamId, user);
    if (!isValidHybridWrapping(dto)) {
      throw new BadRequestException("Invalid post-quantum key wrapping");
    }
    if (!isBase64UrlWithin(dto.encryptedManifest, 64000)) {
      throw new BadRequestException("Invalid encrypted manifest");
    }
    const now = new Date();
    const seat = await this.prisma.teamExternalSeat.findFirst({
      where: { id: dto.seatId, teamId },
    });
    if (!seat || !isSeatUsable(seat, now)) {
      throw new NotFoundException("Seat not found");
    }
    // The source must be a completed file of this team: the server checks it
    // even though the client never needs to send the original anywhere.
    const source = await this.prisma.file.findFirst({
      where: {
        id: dto.sourceFileId,
        share: { hasBeenCompleted: true, teamFolder: { teamId } },
      },
      select: { id: true },
    });
    if (!source) throw new NotFoundException("Source file not found");
    const count = await this.prisma.teamExternalPreview.count({
      where: { seatId: seat.id, deletedAt: null },
    });
    if (count >= EXTERNAL_PREVIEWS_PER_SEAT) {
      throw new BadRequestException(
        "This contractor already has the maximum number of previews",
      );
    }
    const existing = await this.prisma.teamExternalPreview.count({
      where: { id: dto.id },
    });
    if (existing > 0) throw new ConflictException("Preview already exists");
    const preview = await this.prisma.teamExternalPreview.create({
      data: {
        id: dto.id,
        teamId,
        seatId: seat.id,
        sourceFileId: source.id,
        pageCount: dto.pageCount,
        encryptedManifest: dto.encryptedManifest,
        encryptedKey: dto.encryptedKey,
        ephemeralPublicKey: dto.ephemeralPublicKey,
        nonce: dto.nonce,
        kemCiphertext: dto.kemCiphertext,
        algorithm: dto.algorithm,
        createdById: user.id,
      },
      select: { id: true },
    });
    return { id: preview.id };
  }

  private async uploadingPreview(
    teamId: string,
    previewId: string,
    user: User,
  ) {
    await this.assertTeamAdmin(teamId, user);
    const preview = await this.prisma.teamExternalPreview.findFirst({
      where: {
        id: previewId,
        teamId,
        createdById: user.id,
        status: "UPLOADING",
        deletedAt: null,
      },
      select: { id: true, pageCount: true },
    });
    if (!preview) throw new NotFoundException("Preview not found");
    return preview;
  }

  async uploadPage(
    teamId: string,
    previewId: string,
    index: number,
    user: User,
    body: unknown,
  ) {
    const preview = await this.uploadingPreview(teamId, previewId, user);
    if (!Number.isInteger(index) || index < 0 || index >= preview.pageCount) {
      throw new BadRequestException("Invalid page index");
    }
    if (
      !Buffer.isBuffer(body) ||
      body.length < EXTERNAL_PAGE_MIN_BYTES ||
      body.length > EXTERNAL_PAGE_MAX_BYTES
    ) {
      throw new BadRequestException("Invalid encrypted page");
    }
    await this.prisma.$transaction(
      async (tx) => {
        // The same row lock is held by completePreview. A late PUT must never
        // overwrite an already approved, visible object in S3.
        await tx.$executeRaw`UPDATE "TeamExternalPreview" SET "id" = "id" WHERE id = ${preview.id}`;
        const uploading = await tx.teamExternalPreview.findFirst({
          where: {
            id: preview.id,
            teamId,
            createdById: user.id,
            status: "UPLOADING",
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!uploading) throw new NotFoundException("Preview not found");
        await this.fileService.storeFileByKey(
          externalPreviewPageKey(preview.id, index),
          body,
        );
        const sha256 = sha256Hex(body);
        await tx.teamExternalPreviewPage.upsert({
          where: { previewId_index: { previewId: preview.id, index } },
          create: { previewId: preview.id, index, size: body.length, sha256 },
          update: { size: body.length, sha256 },
        });
      },
      { timeout: 60_000 },
    );
    return { index };
  }

  async completePreview(teamId: string, previewId: string, user: User) {
    const preview = await this.uploadingPreview(teamId, previewId, user);
    const stored = await this.prisma.teamExternalPreviewPage.count({
      where: { previewId: preview.id },
    });
    if (stored !== preview.pageCount) {
      throw new ConflictException("Some pages are missing");
    }
    // Visible only once the register entry signed with the passkey matches
    // every stored page.
    const issuanceId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "TeamExternalPreview" SET "id" = "id" WHERE id = ${preview.id}`;
      const id = await this.audit.finalizeIssuance(tx, preview.id);
      const ready = await tx.teamExternalPreview.updateMany({
        where: { id: preview.id, status: "UPLOADING", deletedAt: null },
        data: { status: "READY" },
      });
      if (ready.count !== 1) throw new NotFoundException("Preview not found");
      const seat = await tx.teamExternalSeat.findFirst({
        where: { previews: { some: { id: preview.id } } },
        select: { id: true },
      });
      await this.audit.appendEventInTransaction(tx, {
        teamId,
        kind: "ISSUED",
        actorEmail: user.email,
        previewId: preview.id,
        seatId: seat?.id,
      });
      return id;
    });
    const seat = await this.prisma.teamExternalSeat.findFirst({
      where: { previews: { some: { id: preview.id } } },
      select: { id: true, email: true },
    });
    await this.audit.timestampIssuance(issuanceId);
    await this.logAccess(teamId, user, "EXTERNAL_PREVIEW_SHARE", {
      fileName: seat?.email,
      targetType: "EXTERNAL_PREVIEW",
      targetId: preview.id,
    });
    return { id: preview.id, status: "READY" };
  }

  async deletePreview(teamId: string, previewId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    const deleted = await this.prisma.teamExternalPreview.updateMany({
      where: { id: previewId, teamId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count !== 1) throw new NotFoundException("Preview not found");
    await this.logAccess(teamId, user, "EXTERNAL_PREVIEW_DELETE", {
      targetType: "EXTERNAL_PREVIEW",
      targetId: previewId,
    });
    await this.audit.appendEvent({
      teamId,
      kind: "DELETED",
      actorEmail: user.email,
      previewId,
    });
    void this.purgeHiddenPreviews();
    return { deleted: true };
  }

  // ===========================================================================
  // CONTRACTOR SIDE
  // ===========================================================================

  private async findInvitation(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new NotFoundException("Invalid invitation");
    }
    const seat = await this.prisma.teamExternalSeat.findUnique({
      where: { tokenHash: hashExternalToken(token) },
      include: {
        team: { select: { name: true, isActive: true } },
      },
    });
    const now = new Date();
    if (
      !seat ||
      seat.status !== "PENDING" ||
      seat.inviteExpiresAt <= now ||
      seat.accessExpiresAt <= now ||
      !seat.team.isActive
    ) {
      throw new NotFoundException("Invalid invitation");
    }
    return seat;
  }

  private async hasHybridKeys(userId: string) {
    const [x25519, pqKey] = await Promise.all([
      this.prisma.userIdentityKey.count({
        where: { userId, keyType: "X25519", isActive: true },
      }),
      this.prisma.userPQKey.count({
        where: { userId, isActive: true, variant: "ML-KEM-768" },
      }),
    ]);
    return x25519 > 0 && pqKey > 0;
  }

  /**
   * For a signed-out visitor holding the link: whether to sign in or create
   * an account. Only the bearer of the 256-bit token learns it.
   */
  async getInvitationAccount(token: string) {
    const seat = await this.findInvitation(token);
    const accountExists = await accountEmailExists(this.prisma, seat.email);
    return { email: seat.email, accountExists };
  }

  /** What the invitation page needs before the contractor accepts. */
  async getInvitation(token: string, user: User) {
    const seat = await this.findInvitation(token);
    return {
      teamName: seat.team.name,
      email: seat.email,
      accessExpiresAt: seat.accessExpiresAt,
      emailMatches: user.email.toLowerCase() === seat.email,
      totpEnabled: !!user.totpVerified,
      keysReady: await this.hasHybridKeys(user.id),
    };
  }

  async acceptInvitation(token: string, user: User) {
    const seat = await this.findInvitation(token);
    if (user.email.toLowerCase() !== seat.email) {
      throw new ForbiddenException(
        "This invitation was sent to another e-mail address",
        "external_email_mismatch",
      );
    }
    if (!user.totpVerified) {
      throw new ForbiddenException(
        "Two-factor authentication is required",
        "external_totp_required",
      );
    }
    if (!(await this.hasHybridKeys(user.id))) {
      throw new ConflictException(
        "End-to-end encryption keys are required",
        "external_keys_required",
      );
    }
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId: seat.teamId, userId: user.id, isActive: true },
      select: { id: true },
    });
    if (member) {
      throw new ConflictException("You are already a member of this team");
    }
    const accepted = await this.prisma.teamExternalSeat.updateMany({
      where: { id: seat.id, status: "PENDING", tokenHash: seat.tokenHash },
      data: {
        status: "ACTIVE",
        userId: user.id,
        acceptedAt: new Date(),
        tokenHash: null,
      },
    });
    if (accepted.count !== 1) throw new NotFoundException("Invalid invitation");
    await this.logAccess(seat.teamId, user, "EXTERNAL_JOIN", {
      fileName: seat.email,
    });
    return {
      teamName: seat.team.name,
      accessExpiresAt: seat.accessExpiresAt,
    };
  }

  /**
   * The one filter deciding what a contractor may open. Anything outside it
   * (other seat, revoked or expired access, deleted source, inactive team,
   * unfinished upload, no 2FA) is invisible.
   */
  private contractorPreviewWhere(
    user: User,
    now: Date,
  ): Prisma.TeamExternalPreviewWhereInput {
    return {
      status: "READY",
      deletedAt: null,
      sourceFileId: { not: null },
      team: { isActive: true },
      seat: {
        userId: user.id,
        status: "ACTIVE",
        accessExpiresAt: { gt: now },
      },
    };
  }

  private assertContractorAccount(user: User) {
    if (!user.totpVerified) throw notFound();
  }

  async getContractorStatus(user: User) {
    const now = new Date();
    const seats = await this.prisma.teamExternalSeat.findMany({
      where: {
        userId: user.id,
        status: "ACTIVE",
        accessExpiresAt: { gt: now },
        team: { isActive: true },
      },
      select: { accessExpiresAt: true, team: { select: { name: true } } },
    });
    return {
      totpEnabled: !!user.totpVerified,
      seats: seats.map((seat) => ({
        teamName: seat.team.name,
        accessExpiresAt: seat.accessExpiresAt,
      })),
    };
  }

  private readonly contractorPreviewSelect = {
    id: true,
    pageCount: true,
    createdAt: true,
    encryptedManifest: true,
    encryptedKey: true,
    ephemeralPublicKey: true,
    nonce: true,
    kemCiphertext: true,
    algorithm: true,
    team: { select: { name: true } },
    seat: { select: { accessExpiresAt: true } },
  } satisfies Prisma.TeamExternalPreviewSelect;

  private contractorPreviewView(
    preview: Prisma.TeamExternalPreviewGetPayload<{
      select: TeamExternalService["contractorPreviewSelect"];
    }>,
  ) {
    const { team, seat, ...rest } = preview;
    return {
      ...rest,
      teamName: team.name,
      accessExpiresAt: seat.accessExpiresAt,
    };
  }

  async listContractorPreviews(user: User) {
    this.assertContractorAccount(user);
    const previews = await this.prisma.teamExternalPreview.findMany({
      where: this.contractorPreviewWhere(user, new Date()),
      select: this.contractorPreviewSelect,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return previews.map((preview) => this.contractorPreviewView(preview));
  }

  async getContractorPreview(user: User, previewId: string) {
    this.assertContractorAccount(user);
    const preview = await this.prisma.teamExternalPreview.findFirst({
      where: {
        id: previewId,
        ...this.contractorPreviewWhere(user, new Date()),
      },
      select: { ...this.contractorPreviewSelect, teamId: true, seatId: true },
    });
    if (!preview) throw notFound();
    const { teamId, seatId, ...visible } = preview;
    // Journaled before anything is served: no unrecorded consultation.
    await this.audit.appendEvent({
      teamId,
      kind: "OPENED",
      actorEmail: user.email,
      previewId: preview.id,
      seatId,
    });
    await this.logAccess(teamId, user, "EXTERNAL_PREVIEW_VIEW", {
      targetType: "EXTERNAL_PREVIEW",
      targetId: preview.id,
    });
    return this.contractorPreviewView(visible);
  }

  async getContractorPage(user: User, previewId: string, index: number) {
    this.assertContractorAccount(user);
    const preview = await this.prisma.teamExternalPreview.findFirst({
      where: {
        id: previewId,
        ...this.contractorPreviewWhere(user, new Date()),
      },
      select: { id: true, pageCount: true, teamId: true, seatId: true },
    });
    if (
      !preview ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= preview.pageCount
    ) {
      throw notFound();
    }
    await this.audit.appendEvent({
      teamId: preview.teamId,
      kind: "PAGE",
      actorEmail: user.email,
      previewId: preview.id,
      seatId: preview.seatId,
      pageIndex: index,
    });
    const bytes = await this.fileService.getFileByKey(
      externalPreviewPageKey(preview.id, index),
    );
    // S3 and the database are separate trust boundaries. Check the actual
    // returned ciphertext and reauthorize after storage latency and journaling.
    const page = await this.prisma.teamExternalPreviewPage.findUnique({
      where: { previewId_index: { previewId: preview.id, index } },
      select: { sha256: true, size: true },
    });
    const issuance = await this.prisma.teamExternalIssuance.findUnique({
      where: { previewId },
      select: { status: true, manifest: true },
    });
    const approved =
      issuance?.status === "ISSUED" ? JSON.parse(issuance.manifest) : null;
    if (!approved || new Date(approved.accessExpiresAt) <= new Date())
      throw notFound();
    if (
      !page?.sha256 ||
      page.size !== bytes.length ||
      page.sha256 !== sha256Hex(bytes) ||
      page.sha256 !== approved.copy.pages[index]?.cipherSha256
    ) {
      throw new ConflictException("Stored page integrity check failed");
    }
    const stillAllowed = await this.prisma.teamExternalPreview.findFirst({
      where: {
        id: previewId,
        ...this.contractorPreviewWhere(user, new Date()),
      },
      select: { id: true },
    });
    if (!stillAllowed) throw notFound();
    return bytes;
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  /** Remove the stored pages, then the row. Missing objects are fine. */
  async purgePreview(preview: { id: string; pageCount: number }) {
    for (let index = 0; index < preview.pageCount; index++) {
      try {
        await this.fileService.deleteFileByKey(
          externalPreviewPageKey(preview.id, index),
        );
      } catch {
        // Never uploaded, or already removed.
      }
    }
    await this.prisma.teamExternalPreview.deleteMany({
      where: { id: preview.id },
    });
  }

  /**
   * Copies nobody may see any more: deleted, source file gone, access revoked
   * or expired, account deleted, or an upload abandoned for hours.
   */
  async purgeHiddenPreviews(now = new Date()) {
    try {
      const previews = await this.prisma.teamExternalPreview.findMany({
        where: {
          OR: [
            { deletedAt: { not: null } },
            { sourceFileId: null },
            { seat: { status: "REVOKED" } },
            { seat: { accessExpiresAt: { lte: now } } },
            { seat: { status: "ACTIVE", userId: null } },
            {
              status: "UPLOADING",
              createdAt: {
                lt: new Date(now.getTime() - EXTERNAL_UPLOAD_TTL_MS),
              },
            },
          ],
        },
        select: { id: true, pageCount: true },
        take: 200,
      });
      for (const preview of previews) await this.purgePreview(preview);

      const historyLimit = new Date(now.getTime() - EXTERNAL_SEAT_HISTORY_MS);
      await this.prisma.teamExternalSeat.deleteMany({
        where: {
          previews: { none: {} },
          OR: [
            { status: "REVOKED", revokedAt: { lt: historyLimit } },
            { accessExpiresAt: { lt: historyLimit } },
            { status: "PENDING", inviteExpiresAt: { lt: historyLimit } },
          ],
        },
      });
      return previews.length;
    } catch {
      this.logger.warn("Could not purge external previews");
      return 0;
    }
  }

  /** Called before a team is deleted, the cascade would orphan the pages. */
  /**
   * Before a team is deleted: the journal, which outlives it, records the end
   * of every copy still online, then their pages leave the storage.
   */
  async purgeTeam(teamId: string, actorEmail: string) {
    const previews = await this.prisma.teamExternalPreview.findMany({
      where: { teamId },
      select: { id: true, pageCount: true, status: true, deletedAt: true },
    });
    for (const preview of previews) {
      if (preview.status === "READY" && !preview.deletedAt) {
        await this.audit.appendEvent({
          teamId,
          kind: "DELETED",
          actorEmail,
          previewId: preview.id,
        });
      }
      await this.purgePreview(preview);
    }
  }

  private async logAccess(
    teamId: string,
    user: User,
    action: string,
    data: { fileName?: string; targetType?: string; targetId?: string },
  ) {
    try {
      await this.prisma.teamAccessLog.create({
        data: {
          teamId,
          action,
          actorEmail: user.email,
          actorName: user.username,
          ...data,
        },
      });
    } catch {
      this.logger.debug(`Failed to log ${action}`);
    }
  }
}
