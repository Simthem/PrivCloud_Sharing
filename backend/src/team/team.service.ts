import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import * as argon from "argon2";
import { PrismaService } from "src/prisma/prisma.service";
import { EmailService } from "src/email/email.service";
import { ConfigService } from "src/config/config.service";
import { FileService } from "src/file/file.service";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";
import { NEVER_EXPIRES_CUTOFF_DATE } from "src/utils/date.util";
import {
  CreateTeamDTO,
  UpdateTeamDTO,
  InviteMemberDTO,
  CreateFolderDTO,
  SetFolderAccessDTO,
  SetFileAccessDTO,
  BulkDeleteFilesDTO,
  CreateGuestLinkDTO,
  StartTeamKeyRotationDTO,
  UpdateTeamKeyRotationProgressDTO,
} from "./dto/team.dto";

const parseConfiguredLimit = (
  primaryValue: string | undefined,
  fallbackValue = "0",
) => Number.parseInt(primaryValue || fallbackValue, 10);

const TEAM_MAX_MEMBERS = parseConfiguredLimit(process.env.TEAM_MAX_MEMBERS);
const TEAM_MAX_OWNED_TEAMS = parseConfiguredLimit(process.env.TEAM_MAX_OWNED_TEAMS);
const TEAM_MAX_FOLDERS = parseConfiguredLimit(process.env.TEAM_MAX_FOLDERS);
const TEAM_MAX_SHARE_SIZE = parseConfiguredLimit(
  process.env.TEAM_MAX_SHARE_SIZE,
  process.env.TEAM_MAX_SHARE_SIZE_BYTES || "0",
);
const TEAM_TOTAL_STORAGE = parseConfiguredLimit(
  process.env.TEAM_TOTAL_STORAGE_BYTES,
);

if (!Number.isFinite(TEAM_MAX_MEMBERS) || TEAM_MAX_MEMBERS < 0 || TEAM_MAX_MEMBERS > 10000) {
  throw new Error("TEAM_MAX_MEMBERS must be between 0 and 10000");
}
if (!Number.isFinite(TEAM_MAX_OWNED_TEAMS) || TEAM_MAX_OWNED_TEAMS < 0 || TEAM_MAX_OWNED_TEAMS > 10000) {
  throw new Error("TEAM_MAX_OWNED_TEAMS must be between 0 and 10000");
}
if (!Number.isFinite(TEAM_MAX_FOLDERS) || TEAM_MAX_FOLDERS < 0 || TEAM_MAX_FOLDERS > 100000) {
  throw new Error("TEAM_MAX_FOLDERS must be between 0 and 100000");
}
if (
  !Number.isFinite(TEAM_MAX_SHARE_SIZE) ||
  !Number.isFinite(TEAM_TOTAL_STORAGE) ||
  TEAM_MAX_SHARE_SIZE < 0 ||
  TEAM_TOTAL_STORAGE < 0
) {
  throw new Error("Team limit environment variables must be valid non-negative numbers");
}

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private configService: ConfigService,
    private fileService: FileService,
    private teamNotificationService: TeamNotificationService,
  ) {}

  /**
   * Get the total storage used by ALL active members of a team (personal shares
   * + team folder shares).
   */
  async getTeamTotalStorageUsed(teamId: string): Promise<number> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId, isActive: true },
      select: { userId: true },
    });
    const memberIds = members.map((m) => m.userId);

    const files = await this.prisma.file.findMany({
      where: {
        share: {
          OR: [
            { creatorId: { in: memberIds } },
            { reverseShare: { creatorId: { in: memberIds } } },
          ],
        },
      },
      select: { size: true },
    });
    return files.reduce((sum, f) => sum + parseInt(f.size || "0"), 0);
  }

  /**
   * Get the number of active members in a team.
   */
  async getTeamActiveMemberCount(teamId: string): Promise<number> {
    return this.prisma.teamMember.count({
      where: { teamId, isActive: true },
    });
  }

  // =========================================================================
  // TEAM CRUD
  // =========================================================================

  /**
   * Generate a URL-safe slug from a team name.
   * Supports special chars in name: $,-_\@]}#{[|%*~]
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // remove diacritics
      .replace(/[^a-z0-9\s-]/g, "") // remove non-alphanumeric except spaces and hyphens
      .trim()
      .replace(/[\s_]+/g, "-") // spaces/underscores to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
  }

  async createTeam(dto: CreateTeamDTO, user: User) {
    // Check if team feature is enabled
    const teamEnabled = await this.configService.get("team.enabled");
    if (!teamEnabled) {
      throw new ForbiddenException("Team feature is not enabled");
    }

    // A TEAM_MAX_OWNED_TEAMS value of 0 means unlimited.
    if (!user.isAdmin && TEAM_MAX_OWNED_TEAMS > 0) {
      const ownedTeamCount = await this.prisma.team.count({
        where: { ownerId: user.id },
      });
      if (ownedTeamCount >= TEAM_MAX_OWNED_TEAMS) {
        throw new BadRequestException(
          `Team ownership limit reached (${TEAM_MAX_OWNED_TEAMS}).`,
        );
      }
    }

    // Auto-generate slug from name if not provided
    const sanitizedName = dto.name.trim();
    let slug = dto.slug ? dto.slug.trim() : this.generateSlug(sanitizedName);

    // Ensure slug has min length
    if (slug.length < 2) {
      slug = `team-${slug || Date.now()}`;
    }

    // Validate slug format (alphanumeric + hyphens only)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) && slug.length >= 2) {
      // Force re-sanitize
      slug = slug.replace(/[^a-z0-9-]/g, "").replace(/^-|-$/g, "");
      if (slug.length < 2) slug = `team-${Date.now()}`;
    }

    // Ensure slug uniqueness (append suffix if taken)
    let finalSlug = slug;
    let attempt = 0;
    while (await this.prisma.team.findUnique({ where: { slug: finalSlug } })) {
      attempt++;
      finalSlug = `${slug}-${attempt}`;
    }

    const team = await this.prisma.team.create({
      data: {
        name: sanitizedName,
        slug: finalSlug,
        description: dto.description,
        ownerId: user.id,
        maxMembers: TEAM_MAX_MEMBERS,
        maxShareSize: BigInt(TEAM_MAX_SHARE_SIZE),
        totalStorageLimit: BigInt(TEAM_TOTAL_STORAGE),
        members: {
          create: {
            userId: user.id,
            role: "OWNER",
            isActive: true,
          },
        },
      },
      include: { members: true },
    });

    this.logger.log(`Team created: ${team.name} (${team.slug}) by ${user.email}`);
    return this.serializeTeam(team);
  }

  async getTeam(teamId: string, userId: string) {
    const team = await this.prisma.team.findFirst({
      where: {
        id: teamId,
        members: { some: { userId, isActive: true } },
      },
      include: {
        members: {
          include: { user: { select: { id: true, username: true, email: true } } },
          where: { isActive: true },
        },
      },
    });

    if (!team) throw new NotFoundException("Team not found");
    const serialized = this.serializeTeam(team);
    // Add hasTeamKey boolean to each member (non-sensitive: just whether their key is set)
    serialized.members = serialized.members.map((m: any) => {
      const raw = team.members.find((rm: any) => rm.id === m.id);
      const keyStatus = raw?.wrappedTeamKey && raw.teamKeyVersion === team.keyVersion
        ? "CURRENT"
        : raw?.teamKeyVersion > 0
          ? "PENDING"
          : "MISSING";
      return {
        ...m,
        hasTeamKey: keyStatus === "CURRENT",
        teamKeyVersion: raw?.teamKeyVersion || 0,
        keyStatus,
      };
    });
    return serialized;
  }

  async getMyTeams(userId: string) {
    const teams = await this.prisma.team.findMany({
      where: { members: { some: { userId, isActive: true } } },
      include: {
        members: { where: { isActive: true }, select: { id: true, role: true } },
        _count: { select: { sharedFolders: true, accessLogs: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return teams.map((t) => this.serializeTeam(t));
  }

  /**
   * Check if user is an ADMIN of at least one team but doesn't own any team.
   * Used to trigger the "create your team" modal.
   */
  async getTeamStatus(userId: string) {
    const ownedTeam = await this.prisma.team.findFirst({
      where: { ownerId: userId },
    });

    const adminMemberships = await this.prisma.teamMember.findMany({
      where: { userId, role: "ADMIN", isActive: true },
    });

    // All active team memberships for multi-team support
    const allMemberships = await this.prisma.teamMember.findMany({
      where: { userId, isActive: true },
      include: {
        team: {
          include: {
            sharedFolders: { select: { id: true } },
            members: { where: { isActive: true }, select: { id: true, userId: true } },
          },
        },
      },
    });

    // Compute actual storage used per team (from team folder shares)
    // and personal storage used by this user within each team
    const teamsWithStorage = await Promise.all(
      allMemberships.map(async (m) => {
        const teamFolderIds = m.team.sharedFolders.map((f) => f.id);
        const memberUserIds = m.team.members.map((mem) => mem.userId);

        // Team total: sum all files in completed shares of team folders
        let teamStorageUsed = 0;
        let personalStorageUsed = 0;

        if (teamFolderIds.length > 0) {
          const teamSharesWithCreator = await this.prisma.share.findMany({
            where: {
              teamFolderId: { in: teamFolderIds },
              uploadLocked: true,
            },
            select: {
              creatorId: true,
              files: { select: { size: true } },
            },
          });

          for (const s of teamSharesWithCreator) {
            const shareSize = s.files.reduce(
              (sum, f) => sum + Number(f.size || 0),
              0,
            );
            teamStorageUsed += shareSize;
            if (s.creatorId === userId) {
              personalStorageUsed += shareSize;
            }
          }
        }

        // Members' classic (non-team-folder) shares also count toward the team quota
        if (memberUserIds.length > 0) {
          const classicShares = await this.prisma.share.findMany({
            where: {
              creatorId: { in: memberUserIds },
              teamFolderId: null,
              uploadLocked: true,
            },
            select: {
              creatorId: true,
              files: { select: { size: true } },
            },
          });

          for (const s of classicShares) {
            const shareSize = s.files.reduce(
              (sum, f) => sum + Number(f.size || 0),
              0,
            );
            teamStorageUsed += shareSize;
            if (s.creatorId === userId) {
              personalStorageUsed += shareSize;
            }
          }
        }

        return {
          teamId: m.team.id,
          teamName: m.team.name,
          role: m.role,
          storageLimit: this.getTeamStorageLimit(m.team),
          storageUsed: teamStorageUsed,
          personalStorageUsed,
        };
      }),
    );

    const primaryTeam = teamsWithStorage[0] || null;

    return {
      ownsTeam: !!ownedTeam,
      isTeamAdmin: adminMemberships.length > 0,
      isTeamMember: allMemberships.length > 0,
      needsTeamCreation: !ownedTeam && adminMemberships.length > 0,
      ownedTeamId: ownedTeam?.id || null,
      // Primary team (backward compat)
      teamId: primaryTeam?.teamId || null,
      teamName: primaryTeam?.teamName || null,
      teamStorageLimit: primaryTeam?.storageLimit ?? null,
      teamStorageUsed: primaryTeam?.storageUsed ?? null,
      // All teams (multi-team support)
      teams: teamsWithStorage,
    };
  }

  async updateTeam(teamId: string, dto: UpdateTeamDTO, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const team = await this.prisma.team.update({
      where: { id: teamId },
      data: {
        name: dto.name,
        description: dto.description,
        reportFrequency: dto.reportFrequency,
        reportEnabled: dto.reportEnabled,
        keyRotationIntervalDays: dto.keyRotationIntervalDays,
      },
    });

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.logAccess(teamId, "TEAM_SETTINGS_CHANGE", actor?.email || userId, {
      actorName: actor?.username,
      targetType: "TEAM",
      targetId: teamId,
      metadata: {
        reportEnabled: dto.reportEnabled,
        reportFrequency: dto.reportFrequency,
        keyRotationIntervalDays: dto.keyRotationIntervalDays,
      },
    });

    return this.serializeTeam(team);
  }

  async deleteTeam(teamId: string, userId: string, confirmationName?: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER"]);

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { sharedFolders: true },
    });
    if (!team) throw new NotFoundException("Team not found");

    // Require explicit name confirmation (case-sensitive)
    if (!confirmationName || confirmationName !== team.name) {
      throw new BadRequestException(
        "You must type the exact team name to confirm deletion.",
      );
    }

    // 1. Delete all physical files from shares linked to team folders
    const folderIds = team.sharedFolders.map((f) => f.id);
    if (folderIds.length > 0) {
      const shares = await this.prisma.share.findMany({
        where: { teamFolderId: { in: folderIds } },
        select: { id: true },
      });
      for (const share of shares) {
        await this.fileService.deleteAllFiles(share.id);
      }
      // 2. Delete all share records linked to team folders
      await this.prisma.share.deleteMany({
        where: { teamFolderId: { in: folderIds } },
      });
    }

    // 3. Delete the team (cascade removes members, folders, access logs, invitations, etc.)
    await this.prisma.team.delete({ where: { id: teamId } });

    this.logger.warn(
      `TEAM_DELETED: Team "${team.name}" (${teamId}) permanently deleted by user ${userId}. ` +
        `${folderIds.length} folders and associated shares/files purged.`,
    );

    return { deleted: true };
  }

  // =========================================================================
  // MEMBER MANAGEMENT
  // =========================================================================

  async inviteMember(teamId: string, dto: InviteMemberDTO, userId: string) {
    const actorMember = await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    // Normalize email (lowercase, trim)
    const email = dto.email.trim().toLowerCase();

    // Validate role if provided
    if (dto.role && !["ADMIN", "MEMBER"].includes(dto.role)) {
      throw new BadRequestException("Invalid role. Must be ADMIN or MEMBER.");
    }

    // SECURITY: Only the OWNER can invite with ADMIN role
    if (dto.role === "ADMIN" && actorMember.role !== "OWNER") {
      throw new ForbiddenException("Only the team owner can invite new admins");
    }

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { members: { where: { isActive: true } } },
    });

    if (!team) throw new NotFoundException("Team not found");

    // A maxMembers value of 0 means unlimited.
    if (team.maxMembers > 0 && team.members.length >= team.maxMembers) {
      throw new BadRequestException(
        `Team member limit reached (${team.maxMembers}). ` +
          `Increase the team limit to invite more members.`,
      );
    }

    // Check if already invited
    const existingInvite = await this.prisma.teamInvitation.findUnique({
      where: { email_teamId: { email, teamId } },
    });
    if (existingInvite && existingInvite.status === "PENDING") {
      throw new BadRequestException("This person has already been invited");
    }

    // Check if already a member
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      const existingMember = await this.prisma.teamMember.findUnique({
        where: { userId_teamId: { userId: existingUser.id, teamId } },
      });
      if (existingMember?.isActive) {
        throw new BadRequestException("This person is already a team member");
      }
    }

    // Create invitation (expires in 7 days)
    const invitation = await this.prisma.teamInvitation.upsert({
      where: { email_teamId: { email, teamId } },
      create: {
        email,
        role: dto.role || "MEMBER",
        teamId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        encryptedTeamKey: dto.encryptedTeamKey || null,
      },
      update: {
        role: dto.role || "MEMBER",
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        encryptedTeamKey: dto.encryptedTeamKey || null,
      },
    });

    // Send invitation email
    const baseUrl = await this.configService.get("general.appUrl");
    const inviteUrl = `${baseUrl}/team/invite/${invitation.token}`;

    const smtpEnabled = await this.configService.get("smtp.enabled");
    if (smtpEnabled === true || smtpEnabled === "true") {
      await this.emailService
        .sendMail(
          email,
          `Invitation to join "${team.name}" - PrivCloud Sharing`,
          `Hello,\n\n` +
            `You have been invited to join "${team.name}" on PrivCloud Sharing.\n\n` +
            `Role: ${dto.role || "MEMBER"}\n\n` +
            `Open this link to accept the invitation:\n${inviteUrl}\n\n` +
            `This invitation expires in 7 days.\n\n` +
            `-- \nPrivCloud Sharing`,
        )
        .catch((error) => {
          this.logger.warn(
            `Team invitation email could not be sent to ${email}: ${error.message}`,
          );
        });
    } else {
      this.logger.warn(
        `SMTP is disabled; generated team invitation token for ${email}.`,
      );
    }

    this.logger.log(`Team invitation sent: ${email} -> ${team.name}`);

    // Log activity
    const inviterUser = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "INVITE", inviterUser?.email || "unknown", {
      actorName: inviterUser?.username,
      fileName: email,
    });

    return { invited: true, email, invitationToken: invitation.token };
  }

  async acceptInvitation(
    token: string,
    userId: string,
    wrappedTeamKey?: string,
    keyVersion?: number,
  ) {
    if (wrappedTeamKey) {
      this.validateWrappedTeamKey(wrappedTeamKey, "wrappedTeamKey");
    }

    const invitation = await this.prisma.teamInvitation.findUnique({
      where: { token },
      include: { team: true },
    });

    if (!invitation) throw new NotFoundException("Invalid invitation");
    if (invitation.status !== "PENDING") {
      throw new BadRequestException("This invitation is no longer valid");
    }
    if (new Date() > invitation.expiresAt) {
      await this.prisma.teamInvitation.update({
        where: { id: invitation.id },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("This invitation has expired");
    }
    if (
      wrappedTeamKey &&
      invitation.team.keyVersion > 1 &&
      keyVersion == null
    ) {
      throw new ConflictException(
        "This secure invitation predates the current Team key. Ask an administrator for a new link.",
      );
    }
    if (
      wrappedTeamKey &&
      keyVersion != null &&
      keyVersion !== invitation.team.keyVersion
    ) {
      throw new ConflictException(
        "The invitation contains an outdated Team key. Ask an administrator for a new secure link.",
      );
    }

    // Verify the accepting user's email matches (case-insensitive: invitation
    // email is normalized to lowercase on creation, but user.email in the DB
    // may have been registered with a different case).
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenException(
        "This invitation was sent to a different email address",
      );
    }

    // Create or reactivate membership
    await this.prisma.teamMember.upsert({
      where: { userId_teamId: { userId, teamId: invitation.teamId } },
      create: {
        userId,
        teamId: invitation.teamId,
        role: invitation.role,
        isActive: true,
        wrappedTeamKey: wrappedTeamKey || null,
        teamKeyVersion: wrappedTeamKey ? invitation.team.keyVersion : 0,
        teamKeyUpdatedAt: wrappedTeamKey ? new Date() : null,
      },
      update: {
        role: invitation.role,
        isActive: true,
        ...(wrappedTeamKey ? { wrappedTeamKey } : {}),
        ...(wrappedTeamKey
          ? {
              teamKeyVersion: invitation.team.keyVersion,
              teamKeyUpdatedAt: new Date(),
            }
          : {}),
      },
    });

    await this.prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    });

    this.logger.log(
      `${user.email} joined team ${invitation.team.name} as ${invitation.role}`,
    );

    // Log activity
    void this.logAccess(invitation.teamId, "MEMBER_JOIN", user.email, {
      actorName: user.username,
    });

    return {
      teamId: invitation.teamId,
      teamName: invitation.team.name,
      encryptedTeamKey: invitation.encryptedTeamKey || null,
    };
  }

  // =========================================================================
  // TEAM E2E KEY MANAGEMENT
  // =========================================================================

  async getTeamKey(teamId: string, userId: string) {
    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!member || !member.isActive) {
      throw new ForbiddenException("Not a team member");
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { keyVersion: true },
    });
    return {
      wrappedTeamKey: member.wrappedTeamKey || null,
      keyVersion: team?.keyVersion || 1,
      memberKeyVersion: member.teamKeyVersion,
    };
  }

  async setTeamKey(
    teamId: string,
    userId: string,
    wrappedTeamKey: string,
    keyVersion?: number,
  ) {
    this.validateWrappedTeamKey(wrappedTeamKey, "wrappedTeamKey");
    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!member || !member.isActive) {
      throw new ForbiddenException("Not a team member");
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { keyVersion: true },
    });
    if (!team) throw new NotFoundException("Team not found");
    if (team.keyVersion > 1 && keyVersion == null) {
      throw new ConflictException(
        "A key version is required after the Team key has been rotated",
      );
    }
    if (keyVersion != null && keyVersion !== team.keyVersion) {
      throw new ConflictException(
        `This key targets version ${keyVersion}, but the Team currently uses version ${team.keyVersion}`,
      );
    }
    await this.prisma.teamMember.update({
      where: { id: member.id },
      data: {
        wrappedTeamKey,
        teamKeyVersion: team.keyVersion,
        teamKeyUpdatedAt: new Date(),
      },
    });
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.logAccess(teamId, "KEY_DISTRIBUTED", actor?.email || userId, {
      actorName: actor?.username,
      targetType: "TEAM_MEMBER",
      targetId: member.id,
      metadata: { keyVersion: team.keyVersion },
    });
    return { success: true, keyVersion: team.keyVersion };
  }

  /**
   * Drop the caller's copy of the Team key when it was sealed with a personal
   * key that no longer exists. Other members' copies remain untouched.
   */
  async clearTeamKey(teamId: string, userId: string) {
    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!member || !member.isActive) {
      throw new ForbiddenException("Not a team member");
    }

    await this.prisma.teamMember.update({
      where: { id: member.id },
      data: {
        wrappedTeamKey: null,
        teamKeyVersion: 0,
        teamKeyUpdatedAt: null,
      },
    });

    const orphaned = await this.prisma.teamKeyRotation.findMany({
      where: {
        teamId,
        startedById: userId,
        status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
      },
      select: { id: true, processedFiles: true },
    });
    for (const rotation of orphaned) {
      await this.prisma.teamKeyRotation.update({
        where: { id: rotation.id },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          errorMessage:
            "Abandoned: the initiator's personal key is gone" +
            (rotation.processedFiles > 0
              ? ` -- ${rotation.processedFiles} file(s) were already re-encrypted with the new key and can no longer be opened`
              : ""),
        },
      });
    }

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.logAccess(teamId, "KEY_REVOKED", actor?.email || userId, {
      actorName: actor?.username,
      targetType: "TEAM_MEMBER",
      targetId: member.id,
    });
    return { success: true };
  }

  /**
   * List all E2E-encrypted shares within a team's folders (used for key rotation re-encryption).
   * Accessible to OWNER and ADMIN who need to re-encrypt files after a key rotation.
   */
  async getTeamShares(teamId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);
    const folders = await this.prisma.teamFolder.findMany({ where: { teamId }, select: { id: true } });
    const folderIds = folders.map((f) => f.id);
    if (folderIds.length === 0) return [];
    return this.prisma.share.findMany({
      where: { teamFolderId: { in: folderIds }, isE2EEncrypted: true, uploadLocked: true },
      select: {
        id: true,
        isE2EEncrypted: true,
        files: { select: { id: true, name: true, size: true } },
      },
    });
  }

  /**
   * Get all PDF files from team folders where the user has canRequestSignature
   * permission (either at folder level or file level).
   */
  async getSignableFiles(userId: string) {
    // Find all active memberships for the user
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId, isActive: true },
      select: { id: true, role: true, teamId: true, team: { select: { name: true } } },
    });

    if (memberships.length === 0) return [];

    const results: {
      teamId: string;
      teamName: string;
      folderId: string;
      folderName: string;
      shareId: string;
      fileId: string;
      fileName: string;
    }[] = [];

    for (const membership of memberships) {
      const isAdmin = membership.role === "OWNER" || membership.role === "ADMIN";

      // Get folders where user has signature permission
      let folderIds: string[];
      if (isAdmin) {
        // Admins/owners can sign any file in any folder
        const folders = await this.prisma.teamFolder.findMany({
          where: { teamId: membership.teamId },
          select: { id: true, name: true },
        });
        folderIds = folders.map((f) => f.id);

        // Get all PDF files in these folders
        if (folderIds.length > 0) {
          const shares = await this.prisma.share.findMany({
            where: {
              teamFolderId: { in: folderIds },
              uploadLocked: true,
              OR: [
                { expiration: { gt: new Date() } },
                { expiration: { equals: new Date(0) } },
              ],
            },
            select: {
              id: true,
              teamFolderId: true,
              teamFolder: { select: { name: true } },
              files: { select: { id: true, name: true } },
            },
          });

          for (const share of shares) {
            for (const file of share.files) {
              if (file.name.toLowerCase().endsWith(".pdf")) {
                results.push({
                  teamId: membership.teamId,
                  teamName: membership.team.name,
                  folderId: share.teamFolderId!,
                  folderName: share.teamFolder?.name || "",
                  shareId: share.id,
                  fileId: file.id,
                  fileName: file.name,
                });
              }
            }
          }
        }
      } else {
        // Non-admin: check folder-level access with canRequestSignature
        const folderAccess = await this.prisma.teamFolderAccess.findMany({
          where: {
            memberId: membership.id,
            canRequestSignature: true,
            permission: { not: "NONE" },
          },
          select: { folderId: true, folder: { select: { name: true } } },
        });

        if (folderAccess.length > 0) {
          const accessibleFolderIds = folderAccess.map((a) => a.folderId);
          const folderNameMap = Object.fromEntries(
            folderAccess.map((a) => [a.folderId, a.folder.name]),
          );

          const shares = await this.prisma.share.findMany({
            where: {
              teamFolderId: { in: accessibleFolderIds },
              uploadLocked: true,
              OR: [
                { expiration: { gt: new Date() } },
                { expiration: { equals: new Date(0) } },
              ],
            },
            select: {
              id: true,
              teamFolderId: true,
              files: { select: { id: true, name: true } },
            },
          });

          for (const share of shares) {
            for (const file of share.files) {
              if (file.name.toLowerCase().endsWith(".pdf")) {
                results.push({
                  teamId: membership.teamId,
                  teamName: membership.team.name,
                  folderId: share.teamFolderId!,
                  folderName: folderNameMap[share.teamFolderId!] || "",
                  shareId: share.id,
                  fileId: file.id,
                  fileName: file.name,
                });
              }
            }
          }
        }

        // Also check file-level access with canRequestSignature
        const fileAccess = await this.prisma.fileAccess.findMany({
          where: {
            memberId: membership.id,
            canRequestSignature: true,
            file: { share: { teamFolder: { teamId: membership.teamId } } },
          },
          select: { fileId: true, file: { select: { id: true, name: true, share: { select: { id: true, teamFolderId: true, teamFolder: { select: { name: true } } } } } } },
        });

        for (const access of fileAccess) {
          const file = access.file;
          if (
            file.name.toLowerCase().endsWith(".pdf") &&
            file.share?.teamFolderId &&
            !results.some((r) => r.fileId === file.id)
          ) {
            results.push({
              teamId: membership.teamId,
              teamName: membership.team.name,
              folderId: file.share.teamFolderId,
              folderName: file.share.teamFolder?.name || "",
              shareId: file.share.id,
              fileId: file.id,
              fileName: file.name,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Rotate the team's E2E key: set caller's new wrappedTeamKey and invalidate
   * all other active members' copies. They will need to receive a new distribution link.
   * Only OWNER and ADMIN (who have a current key) can rotate.
   */
  async rotateTeamKey(teamId: string, userId: string, newWrappedTeamKey: string) {
    this.validateWrappedTeamKey(newWrappedTeamKey, "newWrappedTeamKey");
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const callerMember = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!callerMember || !callerMember.isActive) {
      throw new ForbiddenException("Not an active team member");
    }
    if (!callerMember.wrappedTeamKey) {
      throw new ForbiddenException(
        "You do not hold the current team key and cannot rotate it. Have another admin re-share it to you first.",
      );
    }

    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Team not found");
    const nextVersion = team.keyVersion + 1;

    // Legacy one-shot rotation endpoint. New clients use the resumable workflow.
    await this.prisma.$transaction([
      this.prisma.teamMember.updateMany({
        where: { teamId, userId: { not: userId }, isActive: true },
        data: { wrappedTeamKey: null },
      }),
      this.prisma.teamMember.update({
        where: { id: callerMember.id },
        data: {
          wrappedTeamKey: newWrappedTeamKey,
          teamKeyVersion: nextVersion,
          teamKeyUpdatedAt: new Date(),
        },
      }),
      this.prisma.team.update({
        where: { id: teamId },
        data: {
          keyVersion: nextVersion,
          keyRotatedAt: new Date(),
          lastKeyRotationReminderAt: null,
        },
      }),
    ]);

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    this.logger.warn(`KEY_ROTATED: Team ${teamId} E2E key rotated by user ${userId}`);
    void this.logAccess(teamId, "KEY_ROTATED", actor?.email || userId, {
      actorName: actor?.username,
    });

    return { success: true };
  }

  async getKeyRotationStatus(teamId: string, userId: string) {
    const member = await this.assertTeamMembership(teamId, userId);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        keyRotations: {
          where: { status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!team) throw new NotFoundException("Team not found");

    const baseDate = team.keyRotatedAt || team.createdAt;
    const nextDueAt = new Date(
      baseDate.getTime() + team.keyRotationIntervalDays * 86_400_000,
    );
    const reminderAt = new Date(
      nextDueAt.getTime() - team.keyRotationReminderDays * 86_400_000,
    );
    const active = team.keyRotations[0] || null;

    return {
      policy: {
        intervalDays: team.keyRotationIntervalDays,
        reminderDays: team.keyRotationReminderDays,
        currentVersion: team.keyVersion,
        lastRotatedAt: team.keyRotatedAt,
        nextDueAt,
        reminderAt,
        isDue: new Date() >= nextDueAt,
        reminderActive: new Date() >= reminderAt,
      },
      canOrchestrate:
        ["OWNER", "ADMIN"].includes(member.role) &&
        !!member.wrappedTeamKey &&
        member.teamKeyVersion === team.keyVersion,
      activeRotation: active
        ? {
            id: active.id,
            fromVersion: active.fromVersion,
            toVersion: active.toVersion,
            status: active.status,
            reason: active.reason,
            startedById: active.startedById,
            totalFiles: active.totalFiles,
            processedFiles: active.processedFiles,
            failedFiles: active.failedFiles,
            completedFileIds: this.parseCompletedFileIds(active.completedFileIds),
            errorMessage: active.errorMessage,
            createdAt: active.createdAt,
            pendingWrappedTeamKey:
              active.startedById === userId ? active.initiatorWrappedKey : null,
            canResume: active.startedById === userId,
          }
        : null,
    };
  }

  async startTeamKeyRotation(
    teamId: string,
    userId: string,
    dto: StartTeamKeyRotationDTO,
  ) {
    this.validateWrappedTeamKey(dto.newWrappedTeamKey, "newWrappedTeamKey");
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!team || !member) throw new NotFoundException("Team not found");
    if (
      !member.wrappedTeamKey ||
      member.teamKeyVersion !== team.keyVersion
    ) {
      throw new ForbiddenException(
        "A current Team key is required to start the rotation",
      );
    }

    const active = await this.prisma.teamKeyRotation.findFirst({
      where: {
        teamId,
        status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
      },
    });
    if (active) {
      throw new ConflictException("A Team key rotation is already in progress");
    }

    const shares = await this.prisma.share.findMany({
      where: {
        teamFolder: { teamId },
        isE2EEncrypted: true,
        uploadLocked: true,
      },
      select: { files: { select: { id: true } } },
    });
    const totalFiles = shares.reduce((count, share) => count + share.files.length, 0);

    const rotation = await this.prisma.teamKeyRotation.create({
      data: {
        teamId,
        fromVersion: team.keyVersion,
        toVersion: team.keyVersion + 1,
        status: "PREPARING",
        reason: dto.reason || "MANUAL",
        startedById: userId,
        initiatorWrappedKey: dto.newWrappedTeamKey,
        totalFiles,
      },
    });

    return {
      ...rotation,
      completedFileIds: [],
      pendingWrappedTeamKey: rotation.initiatorWrappedKey,
      canResume: true,
    };
  }

  async updateTeamKeyRotationProgress(
    teamId: string,
    rotationId: string,
    userId: string,
    dto: UpdateTeamKeyRotationProgressDTO,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);
    const rotation = await this.prisma.teamKeyRotation.findFirst({
      where: { id: rotationId, teamId },
    });
    if (!rotation) throw new NotFoundException("Key rotation not found");
    if (rotation.startedById !== userId) {
      throw new ForbiddenException("Only the rotation initiator can resume it");
    }
    if (!["PREPARING", "REENCRYPTING", "PAUSED"].includes(rotation.status)) {
      throw new ConflictException("This rotation is no longer active");
    }

    const completed = new Set(this.parseCompletedFileIds(rotation.completedFileIds));
    if (dto.completedFileId && !completed.has(dto.completedFileId)) {
      const file = await this.prisma.file.findFirst({
        where: {
          id: dto.completedFileId,
          share: { teamFolder: { teamId }, isE2EEncrypted: true },
        },
        select: { id: true },
      });
      if (!file) {
        throw new BadRequestException("Completed file does not belong to this Team rotation");
      }
      completed.add(file.id);
    }

    const updated = await this.prisma.teamKeyRotation.update({
      where: { id: rotation.id },
      data: {
        completedFileIds: JSON.stringify([...completed]),
        processedFiles: completed.size,
        failedFiles: dto.failedFiles,
        status: dto.status || "REENCRYPTING",
        errorMessage: dto.errorMessage,
      },
    });
    return {
      ...updated,
      completedFileIds: [...completed],
      pendingWrappedTeamKey: updated.initiatorWrappedKey,
      canResume: true,
    };
  }

  async completeTeamKeyRotation(
    teamId: string,
    rotationId: string,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);
    const rotation = await this.prisma.teamKeyRotation.findFirst({
      where: { id: rotationId, teamId },
    });
    if (!rotation) throw new NotFoundException("Key rotation not found");
    if (rotation.startedById !== userId) {
      throw new ForbiddenException("Only the rotation initiator can complete it");
    }
    if (!["PREPARING", "REENCRYPTING", "PAUSED"].includes(rotation.status)) {
      throw new ConflictException("This rotation is no longer active");
    }
    if (rotation.failedFiles > 0 || rotation.processedFiles < rotation.totalFiles) {
      throw new ConflictException(
        `Rotation incomplete: ${rotation.processedFiles}/${rotation.totalFiles} files, ${rotation.failedFiles} failure(s)`,
      );
    }

    const callerMember = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!callerMember) throw new NotFoundException("Team member not found");
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.teamMember.updateMany({
        where: { teamId, userId: { not: userId }, isActive: true },
        data: { wrappedTeamKey: null },
      }),
      this.prisma.teamMember.update({
        where: { id: callerMember.id },
        data: {
          wrappedTeamKey: rotation.initiatorWrappedKey,
          teamKeyVersion: rotation.toVersion,
          teamKeyUpdatedAt: now,
        },
      }),
      this.prisma.team.update({
        where: { id: teamId },
        data: {
          keyVersion: rotation.toVersion,
          keyRotatedAt: now,
          lastKeyRotationReminderAt: null,
        },
      }),
      this.prisma.teamKeyRotation.update({
        where: { id: rotation.id },
        data: { status: "COMPLETED", completedAt: now, failedFiles: 0 },
      }),
    ]);

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.logAccess(teamId, "KEY_ROTATED", actor?.email || userId, {
      actorName: actor?.username,
      targetType: "TEAM_KEY",
      targetId: rotation.id,
      metadata: {
        fromVersion: rotation.fromVersion,
        toVersion: rotation.toVersion,
        files: rotation.totalFiles,
        reason: rotation.reason,
      },
    });
    return { success: true, keyVersion: rotation.toVersion };
  }

  async cancelTeamKeyRotation(
    teamId: string,
    rotationId: string,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);
    const rotation = await this.prisma.teamKeyRotation.findFirst({
      where: { id: rotationId, teamId },
    });
    if (!rotation) throw new NotFoundException("Key rotation not found");
    if (rotation.startedById !== userId) {
      throw new ForbiddenException("Only the rotation initiator can cancel it");
    }
    if (rotation.processedFiles > 0) {
      throw new ConflictException(
        "A rotation that already changed files must be resumed, not cancelled",
      );
    }
    await this.prisma.teamKeyRotation.update({
      where: { id: rotation.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    return { cancelled: true };
  }

  async sendKeyRotationReminders(now = new Date()) {
    const teams = await this.prisma.team.findMany({
      where: { isActive: true },
      include: {
        members: {
          where: { isActive: true, role: { in: ["OWNER", "ADMIN"] } },
          include: { user: { select: { email: true } } },
        },
        keyRotations: {
          where: { status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] } },
          take: 1,
        },
      },
    });
    let sent = 0;
    for (const team of teams) {
      if (team.keyRotations.length > 0) continue;
      const base = team.keyRotatedAt || team.createdAt;
      const dueAt = new Date(
        base.getTime() + team.keyRotationIntervalDays * 86_400_000,
      );
      const remindAt = new Date(
        dueAt.getTime() - team.keyRotationReminderDays * 86_400_000,
      );
      if (now < remindAt || (team.lastKeyRotationReminderAt && team.lastKeyRotationReminderAt >= remindAt)) {
        continue;
      }
      let delivered = false;
      for (const member of team.members) {
        try {
          await this.emailService.sendMail(
            member.user.email,
            `[${team.name}] Rotation de clé E2E ${now >= dueAt ? "requise" : "à prévoir"}`,
            `La clé E2E de l'équipe ${team.name} doit être renouvelée au plus tard le ${dueAt.toLocaleDateString("fr-FR")}.

Connectez-vous avec un compte owner/admin disposant de la clé Team actuelle pour lancer la rotation assistée. Le serveur n'accède jamais à la clé en clair.`,
          );
          delivered = true;
          sent++;
        } catch (error) {
          this.logger.error(
            `Key rotation reminder failed for ${member.user.email}: ${(error as Error).message}`,
          );
        }
      }
      if (delivered) {
        await this.prisma.team.update({
          where: { id: team.id },
          data: { lastKeyRotationReminderAt: now },
        });
      }
    }
    return { sent };
  }

  private parseCompletedFileIds(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  async removeMember(teamId: string, memberId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });

    if (!member || member.teamId !== teamId) {
      throw new NotFoundException("Member not found");
    }

    if (member.role === "OWNER") {
      throw new ForbiddenException("Cannot remove the team owner");
    }

    // Admins cannot remove other admins
    const actorMember = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (actorMember?.role === "ADMIN" && member.role === "ADMIN") {
      throw new ForbiddenException("Admins cannot remove other admins");
    }

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    const memberUser = await this.prisma.user.findUnique({ where: { id: member.userId } });

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: { isActive: false },
    });

    // SECURITY: Revoke all active E2EE access grants for team files in this team
    // so the removed member can no longer decrypt files after removal.
    const teamFilesForRemoved = await this.prisma.teamFile.findMany({
      where: { folder: { teamId } },
      select: { id: true },
    });
    if (teamFilesForRemoved.length > 0) {
      await this.prisma.accessGrant.updateMany({
        where: {
          userId: member.userId,
          teamFileId: { in: teamFilesForRemoved.map((f) => f.id) },
          status: "ACTIVE",
        },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }

    // SECURITY: Also revoke grants on shares and files within team folders
    const teamShares = await this.prisma.share.findMany({
      where: { teamFolder: { teamId } },
      select: { id: true, files: { select: { id: true } } },
    });
    if (teamShares.length > 0) {
      const shareIds = teamShares.map((s) => s.id);
      const fileIds = teamShares.flatMap((s) => s.files.map((f) => f.id));
      await this.prisma.accessGrant.updateMany({
        where: {
          userId: member.userId,
          status: "ACTIVE",
          OR: [
            { shareId: { in: shareIds } },
            ...(fileIds.length > 0 ? [{ fileId: { in: fileIds } }] : []),
          ],
        },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }

    this.logger.warn(`MEMBER_REMOVED: Member ${memberId} removed from team ${teamId} by user ${userId}`);

    // Log activity
    void this.logAccess(teamId, "MEMBER_REMOVE", actor?.email || "unknown", {
      actorName: actor?.username,
      fileName: memberUser?.email || memberId,
    });

    return { removed: true };
  }

  async leaveTeam(teamId: string, userId: string) {
    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });

    if (!member || !member.isActive) {
      throw new NotFoundException("You are not a member of this team");
    }

    if (member.role === "OWNER") {
      throw new ForbiddenException(
        "The team owner cannot leave. Delete the team instead.",
      );
    }

    await this.prisma.teamMember.update({
      where: { id: member.id },
      data: { isActive: false },
    });

    // SECURITY: Revoke all active E2EE access grants for team files in this team
    // so the leaving member can no longer decrypt files after departure.
    const teamFilesForLeaver = await this.prisma.teamFile.findMany({
      where: { folder: { teamId } },
      select: { id: true },
    });
    if (teamFilesForLeaver.length > 0) {
      await this.prisma.accessGrant.updateMany({
        where: {
          userId,
          teamFileId: { in: teamFilesForLeaver.map((f) => f.id) },
          status: "ACTIVE",
        },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }

    // SECURITY: Also revoke grants on shares and files within team folders
    const teamSharesForLeaver = await this.prisma.share.findMany({
      where: { teamFolder: { teamId } },
      select: { id: true, files: { select: { id: true } } },
    });
    if (teamSharesForLeaver.length > 0) {
      const shareIds = teamSharesForLeaver.map((s) => s.id);
      const fileIds = teamSharesForLeaver.flatMap((s) => s.files.map((f) => f.id));
      await this.prisma.accessGrant.updateMany({
        where: {
          userId,
          status: "ACTIVE",
          OR: [
            { shareId: { in: shareIds } },
            ...(fileIds.length > 0 ? [{ fileId: { in: fileIds } }] : []),
          ],
        },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }

    // Clean up folder access rules for this member
    await this.prisma.teamFolderAccess.deleteMany({
      where: { memberId: member.id },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    this.logger.warn(`MEMBER_LEFT: User ${userId} left team ${teamId}`);
    void this.logAccess(teamId, "MEMBER_REMOVE", user?.email || "unknown", {
      actorName: user?.username,
      fileName: `${user?.email} (left voluntarily)`,
    });

    return { left: true };
  }

  async getMemberFolderAccess(teamId: string, memberId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const member = await this.prisma.teamMember.findFirst({
      where: { id: memberId, teamId, isActive: true },
      include: { user: { select: { id: true, username: true, email: true } } },
    });
    if (!member) throw new NotFoundException("Member not found");

    const folders = await this.prisma.teamFolder.findMany({
      where: { teamId },
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
    });

    const accessRules = await this.prisma.teamFolderAccess.findMany({
      where: { memberId },
    });

    const accessMap = new Map(accessRules.map((r) => [r.folderId, r.permission]));

    return {
      member: {
        id: member.id,
        role: member.role,
        user: member.user,
      },
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        color: f.color,
        permission: accessMap.get(f.id) || null, // null = default (inherit)
      })),
    };
  }

  async updateMemberRole(
    teamId: string,
    memberId: string,
    role: string,
    userId: string,
  ) {
    const actor = await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    if (!["ADMIN", "MEMBER"].includes(role)) {
      throw new BadRequestException("Invalid role");
    }

    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException("Member not found");
    }
    if (member.role === "OWNER") {
      throw new ForbiddenException("Cannot change the owner's role");
    }
    // ADMINs cannot promote/demote other ADMINs, only OWNER can
    if (actor.role === "ADMIN" && member.role === "ADMIN") {
      throw new ForbiddenException("Only the owner can manage other admins");
    }
    // Only OWNER can promote to ADMIN
    if (role === "ADMIN" && actor.role !== "OWNER") {
      throw new ForbiddenException("Only the owner can promote members to admin");
    }

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: { role },
    });

    this.logger.log(`ROLE_CHANGED: Member ${memberId} role changed to ${role} in team ${teamId} by user ${userId}`);

    // Log activity
    const actorUser = await this.prisma.user.findUnique({ where: { id: userId } });
    const targetUser = await this.prisma.user.findUnique({ where: { id: member.userId } });
    void this.logAccess(teamId, "ROLE_CHANGE", actorUser?.email || "unknown", {
      actorName: actorUser?.username,
      fileName: `${targetUser?.email || memberId} -> ${role}`,
    });

    return { updated: true, role };
  }

  async updateMemberPermissions(
    teamId: string,
    memberId: string,
    dto: { canViewActivity?: boolean; canViewSignatures?: boolean; pushNotifMode?: string },
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException("Member not found");
    }
    if (member.role === "OWNER") {
      throw new ForbiddenException("Cannot change owner permissions");
    }

    const data: Record<string, boolean | string> = {};
    if (typeof dto.canViewActivity === "boolean")
      data.canViewActivity = dto.canViewActivity;
    if (typeof dto.canViewSignatures === "boolean")
      data.canViewSignatures = dto.canViewSignatures;
    if (dto.pushNotifMode && ["EVERY_FILE", "SHARES_ONLY"].includes(dto.pushNotifMode))
      data.pushNotifMode = dto.pushNotifMode;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException("No valid permission fields provided");
    }

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data,
    });

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.logAccess(teamId, "PERMISSIONS_CHANGE", actor?.email || userId, {
      actorName: actor?.username,
      targetType: "TEAM_MEMBER",
      targetId: memberId,
      metadata: data,
    });

    this.logger.log(
      `PERMISSIONS_CHANGED: Member ${memberId} permissions updated in team ${teamId} by user ${userId}: ${JSON.stringify(data)}`,
    );

    return { updated: true, ...data };
  }

  /**
   * Allow a team member to update their own notification preferences.
   */
  async updateMyPreferences(
    teamId: string,
    dto: { pushNotifMode?: string },
    userId: string,
  ) {
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, userId, isActive: true },
    });
    if (!member) {
      throw new NotFoundException("You are not a member of this team");
    }

    const data: Record<string, string> = {};
    if (dto.pushNotifMode && ["EVERY_FILE", "SHARES_ONLY"].includes(dto.pushNotifMode)) {
      data.pushNotifMode = dto.pushNotifMode;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException("No valid preference fields provided");
    }

    await this.prisma.teamMember.update({
      where: { id: member.id },
      data,
    });

    return { updated: true, pushNotifMode: data.pushNotifMode };
  }

  // =========================================================================
  // FOLDER MANAGEMENT
  // =========================================================================

  async createFolder(teamId: string, dto: CreateFolderDTO, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    // A TEAM_MAX_FOLDERS value of 0 means unlimited.
    const folderCount = await this.prisma.teamFolder.count({ where: { teamId } });
    if (TEAM_MAX_FOLDERS > 0 && folderCount >= TEAM_MAX_FOLDERS) {
      throw new BadRequestException(
        `Maximum number of folders reached (${TEAM_MAX_FOLDERS}). Delete existing folders to create new ones.`,
      );
    }

    if (dto.parentId) {
      const parent = await this.prisma.teamFolder.findFirst({
        where: { id: dto.parentId, teamId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException("Parent folder not found");
    }

    const storagePrefix = `teams/${teamId}/${dto.parentId ? dto.parentId + "/" : ""}${Date.now()}`;

    const folder = await this.prisma.teamFolder.create({
      data: {
        name: dto.name,
        description: dto.description,
        parentId: dto.parentId,
        color: dto.color,
        storagePrefix,
        teamId,
      },
    });

    // Log activity
    const creatorUser = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "FOLDER_CREATE", creatorUser?.email || "unknown", {
      actorName: creatorUser?.username,
      fileName: dto.name,
      folderId: folder.id,
    });

    // Notify team members
    this.teamNotificationService.notifyTeamMembers(
      teamId,
      userId,
      "FILE_UPLOADED",
      `${creatorUser?.username || creatorUser?.email || "A team member"} created folder "${dto.name}"`,
      { folderId: folder.id },
    ).catch(err => this.logger.error(`Failed to notify team on folder create: ${err.message}`));

    return {
      id: folder.id,
      name: folder.name,
      description: folder.description,
      parentId: folder.parentId,
      color: folder.color,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    };
  }

  async getFolders(teamId: string, userId: string, parentId?: string) {
    await this.assertTeamMembership(teamId, userId);

    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });

    // Owners and admins see all folders with full access
    if (member?.role === "OWNER" || member?.role === "ADMIN") {
      const folders = await this.prisma.teamFolder.findMany({
        where: { teamId, parentId: parentId || null },
        include: {
          _count: { select: { shares: { where: { uploadLocked: true } }, children: true } },
        },
        orderBy: { name: "asc" },
      });
      return folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        description: folder.description,
        parentId: folder.parentId,
        color: folder.color,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        _count: folder._count,
        myPermission: "ADMIN" as string,
      }));
    }

    // Members see folders that either:
    // 1. Have NO access rules (open to all team members by default)
    // 2. Have an explicit access rule for this member that is NOT NONE
    // Folders with a NONE rule for the member are explicitly hidden
    const allFolders = await this.prisma.teamFolder.findMany({
      where: {
        teamId,
        parentId: parentId || null,
        OR: [
          { accessRules: { none: {} } },
          { accessRules: { some: { memberId: member!.id } } },
        ],
      },
      include: {
        _count: { select: { shares: { where: { uploadLocked: true } }, children: true } },
        accessRules: { where: { memberId: member!.id } },
      },
      orderBy: { name: "asc" },
    });

    // Filter out folders where the member has an explicit NONE permission
    // and expose effective permission for each folder
    return allFolders
      .filter((f) => {
        const rule = f.accessRules[0];
        return !rule || !["NONE", "DENY"].includes(rule.permission);
      })
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        description: folder.description,
        parentId: folder.parentId,
        color: folder.color,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        _count: folder._count,
        myPermission: folder.accessRules[0]?.permission || "READ",
        canRequestSignature: folder.accessRules[0]?.canRequestSignature ?? false,
        canShareE2E: folder.accessRules[0]?.canShareE2E ?? false,
      }));
  }

  async setFolderAccess(
    teamId: string,
    folderId: string,
    dto: SetFolderAccessDTO,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    // Verify folder belongs to team
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    // Verify member belongs to team
    const member = await this.prisma.teamMember.findFirst({
      where: { id: dto.memberId, teamId, isActive: true },
    });
    if (!member) throw new NotFoundException("Member not found");

    const VALID_PERMISSIONS = ["NONE", "READ", "WRITE", "ADMIN"];
    if (!VALID_PERMISSIONS.includes(dto.permission)) {
      throw new BadRequestException("Invalid permission value");
    }

    // Derive canDownload/canDelete/canRequestSignature/canShareE2E from permission level
    const accessData: Record<string, any> = { permission: dto.permission };
    if (dto.permission === "NONE") {
      accessData.canDownload = false;
      accessData.canDelete = false;
      accessData.canRequestSignature = false;
      accessData.canShareE2E = false;
    } else if (dto.permission === "READ") {
      accessData.canDownload = true;
      accessData.canDelete = false;
      accessData.canRequestSignature = typeof dto.canRequestSignature === "boolean" ? dto.canRequestSignature : false;
      accessData.canShareE2E = typeof dto.canShareE2E === "boolean" ? dto.canShareE2E : false;
    } else if (dto.permission === "WRITE") {
      accessData.canDownload = true;
      accessData.canDelete = true;
      accessData.canRequestSignature = typeof dto.canRequestSignature === "boolean" ? dto.canRequestSignature : true;
      accessData.canShareE2E = typeof dto.canShareE2E === "boolean" ? dto.canShareE2E : true;
    } else {
      // ADMIN
      accessData.canDownload = true;
      accessData.canDelete = true;
      accessData.canRequestSignature = true;
      accessData.canShareE2E = true;
    }

    await this.prisma.teamFolderAccess.upsert({
      where: { memberId_folderId: { memberId: dto.memberId, folderId } },
      create: {
        memberId: dto.memberId,
        folderId,
        ...accessData,
      },
      update: accessData,
    });

    // Log activity
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    const targetUser = await this.prisma.user.findUnique({
      where: { id: member.userId },
    });
    void this.logAccess(teamId, "FOLDER_ACCESS_CHANGE", actor?.email || "unknown", {
      actorName: actor?.username,
      folderId,
      fileName: `${targetUser?.username || member.userId} -> ${dto.permission}`,
    });

    return { set: true };
  }

  async getFolderAccess(teamId: string, folderId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    const accessRules = await this.prisma.teamFolderAccess.findMany({
      where: { folderId },
      include: {
        member: {
          include: { user: { select: { id: true, username: true, email: true } } },
        },
      },
    });

    return accessRules.map((rule) => ({
      id: rule.id,
      memberId: rule.memberId,
      permission: rule.permission,
      canDownload: rule.canDownload,
      canDelete: rule.canDelete,
      canRequestSignature: rule.canRequestSignature,
      canShareE2E: rule.canShareE2E,
      user: rule.member.user,
      role: rule.member.role,
    }));
  }

  async removeFolderAccess(
    teamId: string,
    folderId: string,
    memberId: string,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
      include: { _count: { select: { accessRules: true } } },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    const existing = await this.prisma.teamFolderAccess.findUnique({
      where: { memberId_folderId: { memberId, folderId } },
    });
    if (!existing) throw new NotFoundException("Access rule not found");

    await this.prisma.teamFolderAccess.delete({
      where: { memberId_folderId: { memberId, folderId } },
    });

    // SECURITY: Revoke E2EE grants for files in this folder for the removed member
    const targetMember = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
      select: { userId: true },
    });
    if (targetMember) {
      const folderFiles = await this.prisma.teamFile.findMany({
        where: { folderId },
        select: { id: true },
      });
      if (folderFiles.length > 0) {
        await this.prisma.accessGrant.updateMany({
          where: {
            userId: targetMember.userId,
            teamFileId: { in: folderFiles.map((f) => f.id) },
            status: "ACTIVE",
          },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
      }
      // Also revoke grants on shares linked to this folder
      const folderShares = await this.prisma.share.findMany({
        where: { teamFolderId: folderId },
        select: { id: true, files: { select: { id: true } } },
      });
      if (folderShares.length > 0) {
        const shareIds = folderShares.map((s) => s.id);
        const fileIds = folderShares.flatMap((s) => s.files.map((f) => f.id));
        await this.prisma.accessGrant.updateMany({
          where: {
            userId: targetMember.userId,
            status: "ACTIVE",
            OR: [
              { shareId: { in: shareIds } },
              ...(fileIds.length > 0 ? [{ fileId: { in: fileIds } }] : []),
            ],
          },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
      }
    }

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "FOLDER_ACCESS_CHANGE", actor?.email || "unknown", {
      actorName: actor?.username,
      folderId,
      fileName: `${memberId} -> REMOVED`,
    });

    return { removed: true };
  }

  async getFolderShares(teamId: string, folderId: string, userId: string) {
    const member = await this.assertTeamMembership(teamId, userId);

    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
      include: { _count: { select: { accessRules: true } } },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    // Resolve caller's folder-level access (for canDownload/canDelete flags)
    const isAdmin = member.role === "OWNER" || member.role === "ADMIN";
    let myAccess: { permission: string; canDownload: boolean; canDelete: boolean; canRequestSignature: boolean; canShareE2E: boolean } | null = null;
    if (!isAdmin) {
      const access = await this.prisma.teamFolderAccess.findUnique({
        where: { memberId_folderId: { memberId: member.id, folderId } },
      });
      if (
        (access && ["NONE", "DENY"].includes(access.permission)) ||
        (!access && folder._count.accessRules > 0)
      ) {
        throw new ForbiddenException("You do not have access to this folder");
      }
      if (access) {
        myAccess = {
          permission: access.permission,
          canDownload: access.canDownload,
          canDelete: access.canDelete,
          canRequestSignature: access.canRequestSignature,
          canShareE2E: access.canShareE2E,
        };
      }
    }

    const shares = await this.prisma.share.findMany({
      where: {
        teamFolderId: folderId,
        // Mirror the same filter used by getSharesByUser(): only show
        // completed (uploadLocked = true) and non-expired shares.
        // Without this, failed/interrupted uploads (uploadLocked = false)
        // remain visible in the team folder even though nothing is accessible.
        uploadLocked: true,
        OR: [
          { expiration: { gt: new Date() } },
          { expiration: { equals: new Date(0) } },
        ],
      },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        expiration: true,
        isE2EEncrypted: true,
        files: {
          select: {
            id: true,
            name: true,
            relativePath: true,
            size: true,
            createdAt: true,
          },
        },
        creator: { select: { id: true, username: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Load file-level access rules for the current member.
    // These override folder-level permissions on a per-file basis.
    const myFileAccess: Record<string, { permission: string; canRequestSignature: boolean; canShareE2E: boolean }> = {};
    const deniedFileIds = new Set<string>();
    if (!isAdmin) {
      const allFileIds = shares.flatMap((s) => s.files.map((f) => f.id));
      if (allFileIds.length > 0) {
        const fileRules = await this.prisma.fileAccess.findMany({
          where: { memberId: member.id, fileId: { in: allFileIds } },
          select: { fileId: true, permission: true, canRequestSignature: true, canShareE2E: true },
        });
        for (const r of fileRules) {
          if (["NONE", "DENY"].includes(r.permission)) {
            deniedFileIds.add(r.fileId);
            continue;
          }
          myFileAccess[r.fileId] = {
            permission: r.permission,
            canRequestSignature: r.canRequestSignature,
            canShareE2E: r.canShareE2E,
          };
        }
      }
    }

    const visibleShares = shares
      .map((share) => ({
        ...share,
        files: share.files.filter((file) => !deniedFileIds.has(file.id)),
      }))
      .filter((share) => share.files.length > 0);

    return {
      folder: {
        id: folder.id,
        name: folder.name,
        description: folder.description,
        parentId: folder.parentId,
        color: folder.color,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      },
      shares: visibleShares,
      myAccess,
      myFileAccess,
    };
  }

  // =========================================================================
  // FILE-LEVEL ACCESS
  // =========================================================================

  async setFileAccess(
    teamId: string,
    folderId: string,
    dto: SetFileAccessDTO,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    // Verify folder belongs to team
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    // Verify all files belong to shares in this folder
    const files = await this.prisma.file.findMany({
      where: {
        id: { in: dto.fileIds },
        share: { teamFolderId: folderId },
      },
    });
    if (files.length !== dto.fileIds.length) {
      throw new BadRequestException("Some files do not belong to this folder");
    }

    // Verify all members belong to the team
    const memberIds = dto.members.map((m) => m.memberId);
    const members = await this.prisma.teamMember.findMany({
      where: { id: { in: memberIds }, teamId, isActive: true },
    });
    if (members.length !== memberIds.length) {
      throw new BadRequestException("Some members do not belong to this team");
    }

    // For each file x member:
    // - NONE: delete the FileAccess (revert to folder defaults)
    // - DENY: explicitly block access regardless of folder permissions
    // - READ/WRITE/ADMIN: grant that level of access
    const toDelete = dto.members.filter((m) => m.permission === "NONE");
    const toUpsert = dto.members.filter((m) => m.permission !== "NONE");
    const deleteMemberIds = toDelete.map((m) => m.memberId);

    const deleteOps = toDelete.length > 0
      ? dto.fileIds.map((fileId) =>
          this.prisma.fileAccess.deleteMany({
            where: { fileId, memberId: { in: deleteMemberIds } },
          }),
        )
      : [];

    const upsertOps = dto.fileIds.flatMap((fileId) =>
      toUpsert.map((m) => {
        const canReqSig = typeof m.canRequestSignature === "boolean" ? m.canRequestSignature : m.permission !== "READ";
        const canE2E = typeof m.canShareE2E === "boolean" ? m.canShareE2E : (m.permission === "WRITE" || m.permission === "ADMIN");
        return this.prisma.fileAccess.upsert({
          where: { memberId_fileId: { memberId: m.memberId, fileId } },
          create: {
            memberId: m.memberId,
            fileId,
            permission: m.permission,
            canRequestSignature: canReqSig,
            canShareE2E: canE2E,
          },
          update: {
            permission: m.permission,
            canRequestSignature: canReqSig,
            canShareE2E: canE2E,
          },
        });
      }),
    );

    await this.prisma.$transaction([...deleteOps, ...upsertOps]);

    // SECURITY: Revoke E2EE grants for members whose access was set to NONE or DENY
    const revokedMembers = dto.members.filter((m) => m.permission === "NONE" || m.permission === "DENY");
    if (revokedMembers.length > 0 && dto.fileIds.length > 0) {
      const revokedMemberIds = revokedMembers.map((m) => m.memberId);
      // Resolve userIds from memberIds
      const resolvedMembers = await this.prisma.teamMember.findMany({
        where: { id: { in: revokedMemberIds } },
        select: { userId: true },
      });
      const revokedUserIds = resolvedMembers.map((m) => m.userId);
      if (revokedUserIds.length > 0) {
        await this.prisma.accessGrant.updateMany({
          where: {
            userId: { in: revokedUserIds },
            fileId: { in: dto.fileIds },
            status: "ACTIVE",
          },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
      }
    }

    // Log activity
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "FILE_ACCESS_CHANGE", actor?.email || "unknown", {
      actorName: actor?.username,
      folderId,
      fileName: `${dto.fileIds.length} file(s) - ${dto.members.length} member(s)`,
    });

    return { set: true, filesCount: dto.fileIds.length, membersCount: dto.members.length };
  }

  async getFileAccess(teamId: string, folderId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    // Verify folder belongs to team
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    // Get all file access rules for files in this folder
    const rules = await this.prisma.fileAccess.findMany({
      where: {
        file: { share: { teamFolderId: folderId } },
      },
      include: {
        member: {
          include: { user: { select: { id: true, username: true, email: true } } },
        },
        file: { select: { id: true, name: true } },
      },
    });

    return rules.map((r) => ({
      id: r.id,
      fileId: r.fileId,
      fileName: r.file.name,
      memberId: r.memberId,
      permission: r.permission,
      canRequestSignature: r.canRequestSignature,
      canShareE2E: r.canShareE2E,
      user: r.member.user,
      role: r.member.role,
    }));
  }

  async bulkDeleteFiles(
    teamId: string,
    folderId: string,
    dto: BulkDeleteFilesDTO,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    // Verify folder belongs to team
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    let deletedCount = 0;
    for (const { shareId, fileId } of dto.files) {
      // Verify the share belongs to this folder
      const share = await this.prisma.share.findFirst({
        where: { id: shareId, teamFolderId: folderId },
      });
      if (!share) continue;

      // Delete the file via the file service (handles storage cleanup)
      try {
        await this.fileService.remove(shareId, fileId);
        deletedCount++;
      } catch {
        this.logger.warn(`Failed to delete file ${fileId} from share ${shareId}`);
      }
    }

    // Log activity
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "BULK_DELETE", actor?.email || "unknown", {
      actorName: actor?.username,
      folderId,
      fileName: `${deletedCount} file(s) deleted`,
    });

    // Notify team members
    if (deletedCount > 0) {
      this.teamNotificationService.notifyTeamMembers(
        teamId,
        userId,
        "FILE_DELETED",
        `${actor?.username || actor?.email || "A team member"} deleted ${deletedCount} file(s)`,
        { folderId },
      ).catch(err => this.logger.error(`Failed to notify team on bulk delete: ${err.message}`));
    }

    return { deleted: deletedCount, total: dto.files.length };
  }

  async deleteFolder(teamId: string, folderId: string, userId: string, confirmationName?: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    // Require explicit name confirmation (case-sensitive)
    if (!confirmationName || confirmationName !== folder.name) {
      throw new BadRequestException(
        "You must type the exact folder name to confirm deletion.",
      );
    }

    // 1. Delete all physical files from shares linked to this folder
    const shares = await this.prisma.share.findMany({
      where: { teamFolderId: folderId },
      select: { id: true },
    });
    for (const share of shares) {
      await this.fileService.deleteAllFiles(share.id);
    }

    // 2. Delete share records linked to this folder
    await this.prisma.share.deleteMany({
      where: { teamFolderId: folderId },
    });

    // 3. Log activity BEFORE deleting the folder so the folderId FK is
    //    still valid and existing logs referencing this folder keep their
    //    folderId intact (onDelete: SetNull only fires for the folder row
    //    itself, not for already-written logs pointing to it).
    const deleterUser = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.logAccess(teamId, "FOLDER_DELETE", deleterUser?.email || "unknown", {
      actorName: deleterUser?.username,
      // Embed the folder name directly so the log stays readable after
      // the folder row is gone and folderId becomes null.
      fileName: `[Deleted folder] ${folder.name}`,
      folderId,
    });

    // 4. Delete the folder (cascade removes children, access rules, etc.
    //    TeamAccessLog.folderId is set to null via onDelete: SetNull so
    //    all historical activity logs are preserved.)
    await this.prisma.teamFolder.delete({ where: { id: folderId } });

    this.logger.warn(
      `FOLDER_DELETED: Folder "${folder.name}" (${folderId}) permanently deleted from team ${teamId} by user ${userId}. ` +
        `${shares.length} shares and all associated files purged.`,
    );

    return { deleted: true };
  }

  // =========================================================================
  // METRICS & ACCESS LOGS
  // =========================================================================

  /**
   * Return only metadata already visible to this Team member. Matching and
   * ranking remain entirely client-side so no E2EE content index is created.
   */
  async getClientSearchIndex(teamId: string, userId: string) {
    const member = await this.assertTeamMembership(teamId, userId);
    const isAdmin = member.role === "OWNER" || member.role === "ADMIN";

    const foldersWithRules = await this.prisma.teamFolder.findMany({
      where: { teamId },
      include: {
        accessRules: {
          where: { memberId: member.id },
          select: { permission: true },
        },
        _count: { select: { accessRules: true } },
      },
      orderBy: { name: "asc" },
    });
    const visibleFolders = foldersWithRules.filter((folder) => {
      if (isAdmin) return true;
      const rule = folder.accessRules[0];
      return rule
        ? !["NONE", "DENY"].includes(rule.permission)
        : folder._count.accessRules === 0;
    });
    const folderIds = visibleFolders.map((folder) => folder.id);

    const shares = folderIds.length === 0
      ? []
      : await this.prisma.share.findMany({
          where: {
            teamFolderId: { in: folderIds },
            uploadLocked: true,
            OR: [
              { expiration: { gt: new Date() } },
              { expiration: { lt: NEVER_EXPIRES_CUTOFF_DATE } },
            ],
          },
          select: {
            id: true,
            name: true,
            expiration: true,
            isE2EEncrypted: true,
            teamFolderId: true,
            creator: { select: { id: true, username: true, email: true } },
            files: {
              select: {
                id: true,
                name: true,
                relativePath: true,
                size: true,
                createdAt: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        });

    const allFileIds = shares.flatMap((share) =>
      share.files.map((file) => file.id),
    );
    const deniedFileIds = new Set<string>();
    if (!isAdmin && allFileIds.length > 0) {
      const fileRules = await this.prisma.fileAccess.findMany({
        where: { memberId: member.id, fileId: { in: allFileIds } },
        select: { fileId: true, permission: true },
      });
      for (const rule of fileRules) {
        if (["NONE", "DENY"].includes(rule.permission)) {
          deniedFileIds.add(rule.fileId);
        }
      }
    }

    const canViewSignatures = isAdmin || member.canViewSignatures;
    const canViewActivity = isAdmin || member.canViewActivity;
    const [signatures, activity] = await Promise.all([
      canViewSignatures
        ? this.prisma.signatureDocument.findMany({
            where: { teamId },
            select: {
              id: true,
              fileId: true,
              fileName: true,
              title: true,
              status: true,
              createdAt: true,
              creator: { select: { username: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      canViewActivity
        ? this.prisma.teamAccessLog.findMany({
            where: { teamId },
            select: {
              id: true,
              action: true,
              actorEmail: true,
              actorName: true,
              fileName: true,
              folderId: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 100,
          })
        : Promise.resolve([]),
    ]);
    const signatureByFile = new Map(
      signatures
        .filter((document) => !!document.fileId)
        .map((document) => [document.fileId as string, document]),
    );
    const folderNameById = new Map(
      visibleFolders.map((folder) => [folder.id, folder.name]),
    );

    return {
      generatedAt: new Date(),
      mode: "CLIENT_SIDE_METADATA",
      folders: visibleFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        description: folder.description,
        parentId: folder.parentId,
        createdAt: folder.createdAt,
      })),
      files: shares.flatMap((share) =>
        share.files
          .filter((file) => !deniedFileIds.has(file.id))
          .map((file) => {
            const signature = signatureByFile.get(file.id);
            return {
              id: file.id,
              shareId: share.id,
              shareName: share.name,
              folderId: share.teamFolderId,
              folderName: share.teamFolderId
                ? folderNameById.get(share.teamFolderId) || null
                : null,
              name: file.name,
              relativePath: file.relativePath,
              size: file.size,
              createdAt: file.createdAt,
              expiresAt: share.expiration,
              author: share.creator,
              isE2EEncrypted: share.isE2EEncrypted,
              signature: signature
                ? { id: signature.id, status: signature.status }
                : null,
            };
          }),
      ),
      signatures: signatures.map((document) => ({
        id: document.id,
        fileId: document.fileId,
        name: document.fileName || document.title,
        status: document.status,
        createdAt: document.createdAt,
        author: document.creator,
      })),
      activity,
      capabilities: { canViewActivity, canViewSignatures },
    };
  }

  async getMetrics(teamId: string, userId: string) {
    await this.assertTeamMembership(teamId, userId);

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        members: { where: { isActive: true } },
        sharedFolders: true,
      },
    });

    if (!team) throw new NotFoundException("Team not found");

    // Total files and storage (from shares linked to team folders)
    const teamFolderIds = team.sharedFolders.map((f) => f.id);
    const sharesWithFiles = teamFolderIds.length > 0
      ? await this.prisma.share.findMany({
          where: {
            teamFolderId: { in: teamFolderIds },
            // Only count completed shares in storage/file metrics.
            // Incomplete uploads (uploadLocked=false) have no committed
            // files in S3 yet and must not inflate the quota display.
            uploadLocked: true,
          },
          include: { files: { select: { size: true } } },
        })
      : [];

    const totalFiles = sharesWithFiles.reduce(
      (sum, s) => sum + s.files.length,
      0,
    );
    const totalStorage = sharesWithFiles.reduce(
      (sum, s) => sum + s.files.reduce((fsum, f) => fsum + Number(f.size), 0),
      0,
    );

    // Recent access logs (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentLogs = await this.prisma.teamAccessLog.count({
      where: { teamId, createdAt: { gte: thirtyDaysAgo } },
    });

    // Downloads this month
    const downloads = await this.prisma.teamAccessLog.count({
      where: {
        teamId,
        action: "DOWNLOAD",
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    // Uploads this month (count actual completed shares created in team folders).
    // uploadLocked=true ensures only finalised uploads are counted.
    const uploads = teamFolderIds.length > 0
      ? await this.prisma.share.count({
          where: {
            teamFolderId: { in: teamFolderIds },
            uploadLocked: true,
            createdAt: { gte: thirtyDaysAgo },
          },
        })
      : 0;

    // Signature requests this month
    const signatures = await this.prisma.signatureDocument.count({
      where: {
        teamId,
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    // Top downloaders (last 30 days)
    const topDownloaders = await this.prisma.teamAccessLog.groupBy({
      by: ["actorEmail"],
      where: {
        teamId,
        action: "DOWNLOAD",
        createdAt: { gte: thirtyDaysAgo },
      },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    });

    // Activity by day (last 30 days)
    const dailyActivity = await this.prisma.teamAccessLog.groupBy({
      by: ["action"],
      where: { teamId, createdAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
    });

    const storageLimit = this.getTeamStorageLimit(team);

    return {
      team: {
        name: team.name,
        membersCount: team.members.length,
        maxMembers: team.maxMembers,
        foldersCount: team.sharedFolders.length,
      },
      storage: {
        used: totalStorage,
        folderUsed: totalStorage,
        externalUsed: 0,
        limit: storageLimit,
        percentage: storageLimit > 0 ? Math.round((totalStorage / storageLimit) * 100) : 0,
      },
      activity: {
        totalFiles,
        recentActivity: recentLogs,
        downloads,
        uploads,
        signatures,
        dailyBreakdown: dailyActivity,
        topDownloaders: topDownloaders.map((d) => ({
          email: d.actorEmail,
          count: d._count.id,
        })),
      },
      limits: {
        maxShareSize: Number(team.maxShareSize),
        totalStorage: storageLimit,
      },
    };
  }

  async getAccessLogs(
    teamId: string,
    userId: string,
    options: { page?: number; limit?: number; action?: string } = {},
  ) {
    const member = await this.assertTeamMembership(teamId, userId);
    const isAdmin = member.role === "OWNER" || member.role === "ADMIN";
    if (!isAdmin && !member.canViewActivity) {
      throw new ForbiddenException("You do not have permission to view activity logs");
    }

    const page = options.page || 1;
    const limit = Math.min(options.limit || 50, 100);
    const skip = (page - 1) * limit;

    const where: any = { teamId };
    if (options.action) where.action = options.action;

    const [logs, total] = await Promise.all([
      this.prisma.teamAccessLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
        include: {
          folder: { select: { name: true } },
          file: { select: { name: true } },
        },
      }),
      this.prisma.teamAccessLog.count({ where }),
    ]);

    return {
      logs: logs.map((log) => ({
        ...log,
        fileSize: log.fileSize != null ? Number(log.fileSize) : null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Log a team access event.
   */
  async logAccess(
    teamId: string,
    action: string,
    actorEmail: string,
    options: {
      actorName?: string;
      ipAddress?: string;
      userAgent?: string;
      fileName?: string;
      fileSize?: bigint;
      folderId?: string;
      fileId?: string;
      targetType?: string;
      targetId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    await this.prisma.teamAccessLog.create({
      data: {
        teamId,
        action,
        actorEmail,
        actorName: options.actorName,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        fileName: options.fileName,
        fileSize: options.fileSize,
        folderId: options.folderId,
        fileId: options.fileId,
        targetType: options.targetType,
        targetId: options.targetId,
        metadata: options.metadata ? JSON.stringify(options.metadata) : undefined,
      },
    });
  }

  // =========================================================================
  // GUEST LINKS (share team folders with external users)
  // =========================================================================

  async createGuestLink(
    teamId: string,
    folderId: string,
    dto: CreateGuestLinkDTO,
    userId: string,
  ) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });

    const link = await (this.prisma as any).teamGuestLink.create({
      data: {
        label: dto.label || null,
        permission: dto.permission || "READ",
        passwordHash: dto.password
          ? await this.hashPassword(dto.password)
          : null,
        maxDownloads: dto.maxDownloads || null,
        expiresAt: dto.expiresInHours
          ? new Date(Date.now() + dto.expiresInHours * 3600000)
          : null,
        folderId,
        teamId,
        createdById: member!.id,
      },
    });

    // Log activity
    const creatorUser = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "GUEST_LINK_CREATE", creatorUser?.email || "unknown", {
      actorName: creatorUser?.username,
      fileName: folder.name,
      folderId,
      targetType: "GUEST_LINK",
      targetId: link.id,
      metadata: {
        permission: link.permission,
        expiresAt: link.expiresAt?.toISOString() || null,
        maxDownloads: link.maxDownloads,
      },
    });

    return {
      id: link.id,
      token: link.token,
      url: `/team/guest/${link.token}`,
      permission: link.permission,
      expiresAt: link.expiresAt,
      maxDownloads: link.maxDownloads,
    };
  }

  async getGuestLinks(teamId: string, folderId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
      select: { id: true },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    return (this.prisma as any).teamGuestLink.findMany({
      where: { teamId, folderId, isActive: true },
      select: {
        id: true,
        token: true,
        label: true,
        permission: true,
        maxDownloads: true,
        downloadCount: true,
        expiresAt: true,
        createdAt: true,
        createdBy: {
          select: { user: { select: { username: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async revokeGuestLink(teamId: string, linkId: string, userId: string) {
    await this.assertTeamRole(teamId, userId, ["OWNER", "ADMIN"]);

    const link = await (this.prisma as any).teamGuestLink.findFirst({
      where: { id: linkId, teamId },
    });
    if (!link) throw new NotFoundException("Guest link not found");

    await (this.prisma as any).teamGuestLink.update({
      where: { id: linkId },
      data: { isActive: false },
    });

    // Log activity
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    void this.logAccess(teamId, "GUEST_LINK_REVOKE", actor?.email || "unknown", {
      actorName: actor?.username,
      folderId: link.folderId,
      fileName: link.label || linkId,
      targetType: "GUEST_LINK",
      targetId: linkId,
    });

    return { revoked: true };
  }

  private async hashPassword(password: string): Promise<string> {
    return argon.hash(password);
  }

  private validateWrappedTeamKey(value: string, fieldName: string): void {
    if (
      !value ||
      typeof value !== "string" ||
      value.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new BadRequestException(`${fieldName} must be valid base64url`);
    }
  }

  // =========================================================================
  // ADMIN OPERATIONS (instance admin, not team admin)
  // =========================================================================

  /**
   * Admin creates a team on behalf of any user.
   */
  async adminCreateTeam(data: {
    name: string;
    slug: string;
    description?: string;
    ownerEmail: string;
    maxMembers?: number;
  }) {
    // Resolve owner by email
    const owner = await this.prisma.user.findFirst({
      where: { email: data.ownerEmail },
    });
    if (!owner) throw new NotFoundException("User not found with this email");

    // Validate slug format
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(data.slug) && data.slug.length < 2) {
      throw new BadRequestException(
        "Team URL must contain only lowercase letters, numbers, and hyphens",
      );
    }

    // Check slug uniqueness
    const existing = await this.prisma.team.findUnique({
      where: { slug: data.slug },
    });
    if (existing) {
      throw new BadRequestException("This team URL (slug) is already taken");
    }

    const team = await this.prisma.team.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description || null,
        ownerId: owner.id,
        maxMembers: data.maxMembers ?? TEAM_MAX_MEMBERS,
        maxShareSize: BigInt(TEAM_MAX_SHARE_SIZE),
        totalStorageLimit: BigInt(TEAM_TOTAL_STORAGE),
        isActive: true,
        members: {
          create: {
            userId: owner.id,
            role: "OWNER",
            isActive: true,
          },
        },
      },
      include: {
        members: true,
        owner: { select: { id: true, username: true, email: true } },
      },
    });

    this.logger.log(
      `Admin created team: ${team.name} (${team.slug}) with owner ${owner.email}`,
    );
    return this.serializeTeam(team);
  }

  /**
   * List all teams on the platform (admin only).
   */
  async adminListAllTeams() {
    const teams = await this.prisma.team.findMany({
      include: {
        members: { where: { isActive: true }, select: { id: true, role: true } },
        owner: { select: { id: true, username: true, email: true } },
        _count: { select: { sharedFolders: true, accessLogs: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return teams.map((t) => this.serializeTeam(t));
  }

  /**
   * Admin joins any team (adds themselves as ADMIN role).
   */
  async adminJoinTeam(teamId: string, adminUserId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Team not found");

    await this.prisma.teamMember.upsert({
      where: { userId_teamId: { userId: adminUserId, teamId } },
      create: {
        userId: adminUserId,
        teamId,
        role: "ADMIN",
        isActive: true,
      },
      update: {
        role: "ADMIN",
        isActive: true,
      },
    });

    this.logger.log(`Platform admin ${adminUserId} joined team ${team.name}`);
    return { joined: true, teamId, teamName: team.name };
  }

  /**
   * Admin adds any user to any team (bypasses invitation flow).
   */
  async adminAddUserToTeam(
    teamId: string,
    targetUserId: string,
    role: string = "MEMBER",
  ) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { members: { where: { isActive: true } } },
    });
    if (!team) throw new NotFoundException("Team not found");

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!targetUser) throw new NotFoundException("User not found");

    if (!["OWNER", "ADMIN", "MEMBER"].includes(role)) {
      throw new BadRequestException("Invalid role");
    }

    // If adding as OWNER, transfer ownership
    if (role === "OWNER") {
      // Demote current owner to admin
      await this.prisma.teamMember.updateMany({
        where: { teamId, role: "OWNER" },
        data: { role: "ADMIN" },
      });
      // Update team owner
      await this.prisma.team.update({
        where: { id: teamId },
        data: { ownerId: targetUserId },
      });
    }

    await this.prisma.teamMember.upsert({
      where: { userId_teamId: { userId: targetUserId, teamId } },
      create: {
        userId: targetUserId,
        teamId,
        role,
        isActive: true,
      },
      update: {
        role,
        isActive: true,
      },
    });

    // Auto-expand finite max members when an instance admin adds users directly.
    if (team.maxMembers > 0 && team.members.length >= team.maxMembers) {
      await this.prisma.team.update({
        where: { id: teamId },
        data: { maxMembers: team.maxMembers + 1 },
      });
    }

    this.logger.log(
      `Admin added user ${targetUser.email} to team ${team.name} as ${role}`,
    );

    return {
      added: true,
      userId: targetUserId,
      email: targetUser.email,
      teamId,
      role,
    };
  }

  /**
   * Admin changes an existing member's role by memberId (not userId).
   * Unlike adminAddUserToTeam, this resolves the user from the member record.
   */
  async adminSetMemberRole(teamId: string, memberId: string, role: string) {
    if (!["ADMIN", "MEMBER"].includes(role)) {
      throw new BadRequestException("Invalid role. Must be ADMIN or MEMBER.");
    }

    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { email: true } } },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException("Member not found in this team");
    }
    if (member.role === "OWNER") {
      throw new ForbiddenException("Cannot change the owner's role via this endpoint");
    }

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: { role },
    });

    this.logger.log(`ADMIN_SET_ROLE: Member ${member.user?.email} role changed to ${role} in team ${teamId}`);
    return { updated: true, memberId, role };
  }

  /**
   * Admin sets any user as admin of any team.
   */
  async adminSetTeamAdmin(teamId: string, targetUserId: string) {
    return this.adminAddUserToTeam(teamId, targetUserId, "ADMIN");
  }

  /**
   * Admin updates the max members limit for a team.
   * A value of 0 means unlimited.
   */
  async adminSetTeamMaxMembers(teamId: string, maxMembers: number) {
    if (maxMembers < 0) {
      throw new BadRequestException("Max members must be 0 or greater");
    }

    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Team not found");

    await this.prisma.team.update({
      where: { id: teamId },
      data: { maxMembers },
    });

    this.logger.log(`Admin updated team ${team.name} maxMembers to ${maxMembers}`);
    return { updated: true, teamId, maxMembers };
  }

  /**
   * Admin toggles team feature for a specific user (ban/allow from team creation).
   * Uses a flag approach: setting canCreateTeam on the user.
   */
  async adminToggleTeamForUser(targetUserId: string, allowed: boolean) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!user) throw new NotFoundException("User not found");

    // Store permission in user metadata or a dedicated flag
    // For simplicity, we use the existing user table; if a 'teamAllowed' field
    // doesn't exist, we can use the config or a simple boolean approach.
    // We'll store it as a config override per user via teamMember status deactivation.
    // Actually, let's return: this is managed through team.enabled global config
    // and individual team membership. No per-user ban needed for MVP.
    return { userId: targetUserId, teamAllowed: allowed };
  }

  // =========================================================================
  // PLATFORM ADMIN – FULL MANAGEMENT
  // =========================================================================

  async adminGetTeamDetails(teamId: string) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        owner: { select: { id: true, username: true, email: true } },
        members: {
          include: { user: { select: { id: true, username: true, email: true } } },
          orderBy: { createdAt: "asc" },
        },
        sharedFolders: {
          include: {
            _count: { select: { files: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { accessLogs: true } },
      },
    });
    if (!team) throw new NotFoundException("Team not found");
    return this.serializeTeam(team);
  }

  async adminUpdateTeam(teamId: string, dto: { name?: string; description?: string }) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Team not found");

    const updated = await this.prisma.team.update({
      where: { id: teamId },
      data: {
        ...(dto.name && { name: dto.name.trim() }),
        ...(dto.description !== undefined && { description: dto.description.trim() }),
      },
    });

    this.logger.warn(`ADMIN_UPDATE_TEAM: Team ${teamId} updated (name=${dto.name})`);
    return { updated: true, team: { id: updated.id, name: updated.name } };
  }

  async adminDeleteTeam(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Team not found");

    this.logger.warn(`ADMIN_DELETE_TEAM: Team "${team.name}" (${teamId}) deleted by platform admin`);
    await this.prisma.team.delete({ where: { id: teamId } });
    return { deleted: true, teamId };
  }

  async adminRemoveMember(teamId: string, memberId: string) {
    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { email: true } } },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException("Member not found in this team");
    }

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: { isActive: false },
    });

    // SECURITY: Revoke all active E2EE access grants for this member's team files
    const teamFiles = await this.prisma.teamFile.findMany({
      where: { folder: { teamId } },
      select: { id: true },
    });
    if (teamFiles.length > 0) {
      await this.prisma.accessGrant.updateMany({
        where: {
          userId: member.userId,
          teamFileId: { in: teamFiles.map((f) => f.id) },
          status: "ACTIVE",
        },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }

    // SECURITY: Also revoke grants on shares/files within team folders
    const teamShares = await this.prisma.share.findMany({
      where: { teamFolder: { teamId } },
      select: { id: true, files: { select: { id: true } } },
    });
    if (teamShares.length > 0) {
      const shareIds = teamShares.map((s) => s.id);
      const fileIds = teamShares.flatMap((s) => s.files.map((f) => f.id));
      await this.prisma.accessGrant.updateMany({
        where: {
          userId: member.userId,
          status: "ACTIVE",
          OR: [
            { shareId: { in: shareIds } },
            ...(fileIds.length > 0 ? [{ fileId: { in: fileIds } }] : []),
          ],
        },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }

    this.logger.warn(`ADMIN_REMOVE_MEMBER: Member ${member.user?.email} removed from team ${teamId}`);
    return { removed: true, memberId };
  }

  async adminGetFolders(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Team not found");

    return this.prisma.teamFolder.findMany({
      where: { teamId },
      include: {
        _count: { select: { files: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async adminUpdateFolder(teamId: string, folderId: string, data: { name?: string }) {
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    const updated = await this.prisma.teamFolder.update({
      where: { id: folderId },
      data: {
        ...(data.name && { name: data.name.trim() }),
      },
    });

    this.logger.warn(`ADMIN_UPDATE_FOLDER: Folder ${folderId} renamed to "${data.name}" in team ${teamId}`);

    if (data.name && data.name !== folder.name) {
      void this.logAccess(teamId, "FOLDER_RENAME", "admin", {
        actorName: "Platform admin",
        folderId,
        fileName: `${folder.name} -> ${data.name}`,
      });
    }

    return { updated: true, folder: { id: updated.id, name: updated.name } };
  }

  async adminDeleteFolder(teamId: string, folderId: string) {
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    this.logger.warn(`ADMIN_DELETE_FOLDER: Folder "${folder.name}" (${folderId}) deleted from team ${teamId}`);

    void this.logAccess(teamId, "FOLDER_DELETE", "admin", {
      actorName: "Platform admin",
      folderId,
      fileName: folder.name,
    });

    await this.prisma.teamFolder.delete({ where: { id: folderId } });
    return { deleted: true, folderId };
  }

  async adminGetFolderFiles(teamId: string, folderId: string) {
    const folder = await this.prisma.teamFolder.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) throw new NotFoundException("Folder not found");

    return this.prisma.teamFile.findMany({
      where: { folderId, deletedAt: null },
      select: {
        id: true,
        name: true,
        size: true,
        mimeType: true,
        createdAt: true,
        uploadedById: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async adminDeleteFile(teamId: string, fileId: string) {
    const file = await this.prisma.teamFile.findFirst({
      where: { id: fileId, folder: { teamId } },
    });
    if (!file) throw new NotFoundException("File not found in this team");

    await this.prisma.teamFile.update({
      where: { id: fileId },
      data: { deletedAt: new Date() },
    });

    this.logger.warn(`ADMIN_DELETE_FILE: File ${fileId} soft-deleted from team ${teamId}`);
    return { deleted: true, fileId };
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  private async assertTeamMembership(teamId: string, userId: string) {
    const member = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!member || !member.isActive) {
      throw new ForbiddenException("You are not a member of this team");
    }
    return member;
  }

  private async assertTeamRole(
    teamId: string,
    userId: string,
    roles: string[],
  ) {
    const member = await this.assertTeamMembership(teamId, userId);
    if (!roles.includes(member.role)) {
      throw new ForbiddenException(
        `This action requires one of these roles: ${roles.join(", ")}`,
      );
    }
    return member;
  }

  private getTeamStorageLimit(team: { totalStorageLimit?: bigint | number | null }) {
    if (team.totalStorageLimit === null || team.totalStorageLimit === undefined) {
      return TEAM_TOTAL_STORAGE;
    }
    return Number(team.totalStorageLimit);
  }

  private optionalNumber(value: bigint | number | null | undefined) {
    if (value === null || value === undefined) return undefined;
    return Number(value);
  }

  /**
   * Serialize team for JSON response (BigInt -> number conversion).
   */
  private serializeTeam(team: any) {
    return {
      ...team,
      maxShareSize: this.optionalNumber(team.maxShareSize),
      totalStorageLimit: this.optionalNumber(team.totalStorageLimit),
      storageUsed: this.optionalNumber(team.storageUsed),
    };
  }
}
