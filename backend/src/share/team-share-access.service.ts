import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";

const DENY_PERMISSIONS = ["NONE", "DENY"];
const ALLOW_PERMISSIONS = ["READ", "WRITE", "ADMIN"];
const MANAGE_PERMISSIONS = ["WRITE", "ADMIN"];

type TeamShareAccessOptions = {
  allowPlatformAdmin?: boolean;
  forbidDeniedFiles?: boolean;
  requireDownload?: boolean;
};

@Injectable()
export class TeamShareAccessService {
  constructor(private prisma: PrismaService) {}

  async assertCanAccessShare(
    shareId: string,
    user: User | undefined,
    options: TeamShareAccessOptions = {},
  ): Promise<void> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: {
        id: true,
        isE2EEncrypted: true,
        teamFolderId: true,
        teamFolder: { select: { id: true, teamId: true } },
        files: { select: { id: true } },
      },
    });

    if (!share) throw new NotFoundException("Share not found");
    if (!share.teamFolderId) return;
    if (!share.teamFolder) {
      throw new ForbiddenException(
        "Team share folder is unavailable",
        "team_share_access_denied",
      );
    }

    const membership = await this.assertTeamMembership(
      share.teamFolder.teamId,
      user,
      options.allowPlatformAdmin,
    );
    await this.assertNoConflictingKeyRotation(
      share.teamFolder.teamId,
      share.isE2EEncrypted,
      user,
    );
    if (!membership) return;

    const isTeamAdmin =
      membership.role === "OWNER" || membership.role === "ADMIN";
    if (isTeamAdmin) return;

    const folderAccess = await this.prisma.teamFolderAccess.findUnique({
      where: {
        memberId_folderId: {
          memberId: membership.id,
          folderId: share.teamFolderId,
        },
      },
    });

    if (
      folderAccess &&
      DENY_PERMISSIONS.includes(folderAccess.permission)
    ) {
      throw new ForbiddenException(
        "You do not have access to this team share",
        "team_share_access_denied",
      );
    }

    if (options.requireDownload && folderAccess && !folderAccess.canDownload) {
      throw new ForbiddenException(
        "You do not have download access to this team share",
        "team_share_access_denied",
      );
    }

    if (options.forbidDeniedFiles !== false && share.files.length > 0) {
      const deniedFileCount = await this.prisma.fileAccess.count({
        where: {
          memberId: membership.id,
          fileId: { in: share.files.map((file) => file.id) },
          permission: { in: DENY_PERMISSIONS },
        },
      });

      if (deniedFileCount > 0) {
        throw new ForbiddenException(
          "You do not have access to every file in this team share",
          "team_share_access_denied",
        );
      }
    }
  }

  async assertCanAccessFile(
    shareId: string,
    fileId: string,
    user: User | undefined,
    options: Pick<TeamShareAccessOptions, "allowPlatformAdmin"> = {},
  ): Promise<void> {
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
      select: {
        id: true,
        share: {
          select: {
            id: true,
            isE2EEncrypted: true,
            teamFolderId: true,
            teamFolder: { select: { id: true, teamId: true } },
          },
        },
      },
    });

    if (!file) throw new NotFoundException("File not found");
    const share = file.share;
    if (!share.teamFolderId) return;
    if (!share.teamFolder) {
      throw new ForbiddenException(
        "Team share folder is unavailable",
        "team_share_access_denied",
      );
    }

    const membership = await this.assertTeamMembership(
      share.teamFolder.teamId,
      user,
      options.allowPlatformAdmin,
    );
    await this.assertNoConflictingKeyRotation(
      share.teamFolder.teamId,
      share.isE2EEncrypted,
      user,
    );
    if (!membership) return;

    const isTeamAdmin =
      membership.role === "OWNER" || membership.role === "ADMIN";
    if (isTeamAdmin) return;

    const fileAccess = await this.prisma.fileAccess.findUnique({
      where: { memberId_fileId: { memberId: membership.id, fileId } },
    });

    if (fileAccess) {
      if (DENY_PERMISSIONS.includes(fileAccess.permission)) {
        throw new ForbiddenException(
          "You do not have access to this team file",
          "team_share_access_denied",
        );
      }

      if (ALLOW_PERMISSIONS.includes(fileAccess.permission)) {
        return;
      }
    }

    const folderAccess = await this.prisma.teamFolderAccess.findUnique({
      where: {
        memberId_folderId: {
          memberId: membership.id,
          folderId: share.teamFolderId,
        },
      },
    });

    if (
      folderAccess &&
      (DENY_PERMISSIONS.includes(folderAccess.permission) ||
        !folderAccess.canDownload)
    ) {
      throw new ForbiddenException(
        "You do not have access to this team file",
        "team_share_access_denied",
      );
    }
  }

  async assertCanManageShare(
    shareId: string,
    user: User | undefined,
    options: Pick<TeamShareAccessOptions, "allowPlatformAdmin"> = {},
  ): Promise<void> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: {
        id: true,
        teamFolderId: true,
        teamFolder: { select: { id: true, teamId: true } },
        files: { select: { id: true } },
      },
    });

    if (!share) throw new NotFoundException("Share not found");
    if (!share.teamFolderId) return;
    if (!share.teamFolder) {
      throw new ForbiddenException(
        "Team share folder is unavailable",
        "team_share_access_denied",
      );
    }

    const membership = await this.assertTeamMembership(
      share.teamFolder.teamId,
      user,
      options.allowPlatformAdmin,
    );
    if (!membership) return;

    const isTeamAdmin =
      membership.role === "OWNER" || membership.role === "ADMIN";
    if (isTeamAdmin) return;

    const folderAccess = await this.prisma.teamFolderAccess.findUnique({
      where: {
        memberId_folderId: {
          memberId: membership.id,
          folderId: share.teamFolderId,
        },
      },
    });

    if (
      !folderAccess ||
      DENY_PERMISSIONS.includes(folderAccess.permission) ||
      !MANAGE_PERMISSIONS.includes(folderAccess.permission)
    ) {
      throw new ForbiddenException(
        "You do not have write access to this team share",
        "team_share_access_denied",
      );
    }

    if (share.files.length > 0) {
      const deniedFileCount = await this.prisma.fileAccess.count({
        where: {
          memberId: membership.id,
          fileId: { in: share.files.map((file) => file.id) },
          permission: { in: DENY_PERMISSIONS },
        },
      });

      if (deniedFileCount > 0) {
        throw new ForbiddenException(
          "You do not have write access to every file in this team share",
          "team_share_access_denied",
        );
      }
    }
  }

  private async assertTeamMembership(
    teamId: string,
    user: User | undefined,
    allowPlatformAdmin = false,
  ) {
    if (!user) {
      throw new UnauthorizedException(
        "Authentication is required for team shares",
        "team_share_auth_required",
      );
    }

    if (allowPlatformAdmin && user.isAdmin) return null;

    const membership = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId: user.id, teamId } },
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException(
        "You are not an active member of this team",
        "team_share_access_denied",
      );
    }

    return membership;
  }

  private async assertNoConflictingKeyRotation(
    teamId: string,
    isE2EEncrypted: boolean,
    user: User | undefined,
  ) {
    if (!isE2EEncrypted || !user) return;

    const rotation = await this.prisma.teamKeyRotation.findFirst({
      where: {
        teamId,
        status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
      },
      select: { startedById: true },
    });
    if (rotation && rotation.startedById !== user.id) {
      throw new ForbiddenException(
        "This Team share is temporarily unavailable during key rotation",
        "team_key_rotation_in_progress",
      );
    }
  }
}
