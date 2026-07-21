import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";
import { CreateAccessGrantDTO, BulkCreateGrantsDTO } from "./dto/crypto.dto";

@Injectable()
export class AccessGrantService {
  private readonly logger = new Logger(AccessGrantService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Create an access grant: encrypt a file's DEK for a specific user.
   * The encryption is done CLIENT-SIDE - we only store the result.
   *
   * Flow:
   * 1. Client fetches recipient's public key via /crypto/identity/keys/user/:id
   * 2. Client performs X25519 ECDH -> shared secret -> AES-256-GCM(DEK)
   * 3. Client sends the encrypted DEK, ephemeral PK, and nonce here
   * 4. Server stores blindly - never sees the DEK
   */
  async createGrant(grantorId: string, dto: CreateAccessGrantDTO) {
    // Validate that EXACTLY one target is specified (prevents cross-resource grants)
    const _grantTargets = [dto.fileId, dto.teamFileId, dto.shareId].filter(Boolean);
    if (_grantTargets.length === 0) {
      throw new BadRequestException(
        "Exactly one of fileId, teamFileId, or shareId must be specified",
      );
    }
    if (_grantTargets.length > 1) {
      throw new BadRequestException(
        "Only one of fileId, teamFileId, or shareId may be specified per grant",
      );
    }

    // Validate recipient exists and has an active X25519 key
    const recipientKey = await this.prisma.userIdentityKey.findFirst({
      where: {
        userId: dto.recipientUserId,
        keyType: "X25519",
        isActive: true,
      },
    });

    if (!recipientKey) {
      throw new BadRequestException(
        "Recipient does not have an active X25519 key. They must set up E2EE first.",
      );
    }

    // Validate grantor has access to the resource
    await this.validateGrantorAccess(grantorId, dto);

    // Check for duplicate active grant
    const existingGrant = await this.prisma.accessGrant.findFirst({
      where: {
        userId: dto.recipientUserId,
        fileId: dto.fileId || undefined,
        teamFileId: dto.teamFileId || undefined,
        shareId: dto.shareId || undefined,
        status: "ACTIVE",
      },
    });

    if (existingGrant) {
      // Update existing grant (re-encryption scenario)
      const updated = await this.prisma.accessGrant.update({
        where: { id: existingGrant.id },
        data: {
          encryptedFileKey: dto.encryptedFileKey,
          ephemeralPublicKey: dto.ephemeralPublicKey,
          nonce: dto.nonce,
          algorithm: dto.algorithm || "x25519-aes256gcm",
          grantorId,
          dekVersion: existingGrant.dekVersion + 1,
        },
      });

      void this.logTeamGrantEvent(
        grantorId,
        dto,
        "E2E_SHARE",
        updated.id,
      );

      return { id: updated.id, action: "updated", dekVersion: updated.dekVersion };
    }

    // Create new grant
    const grant = await this.prisma.accessGrant.create({
      data: {
        encryptedFileKey: dto.encryptedFileKey,
        ephemeralPublicKey: dto.ephemeralPublicKey,
        nonce: dto.nonce,
        algorithm: dto.algorithm || "x25519-aes256gcm",
        grantorId,
        userId: dto.recipientUserId,
        fileId: dto.fileId,
        teamFileId: dto.teamFileId,
        shareId: dto.shareId,
        dekVersion: 1,
        status: "ACTIVE",
      },
    });

    this.logger.log(
      `Grant created: ${grant.id} for user ${dto.recipientUserId} ` +
        `(file=${dto.fileId || dto.teamFileId || "share:" + dto.shareId})`,
    );

    void this.logTeamGrantEvent(grantorId, dto, "E2E_SHARE", grant.id);

    return { id: grant.id, action: "created", dekVersion: grant.dekVersion };
  }

  /**
   * Bulk create grants (for sharing with multiple team members at once).
   * Each grant is validated independently - partial success is possible.
   */
  async createBulkGrants(grantorId: string, dto: BulkCreateGrantsDTO) {
    if (!dto.grants || dto.grants.length === 0) {
      throw new BadRequestException("grants array is required and non-empty");
    }
    if (dto.grants.length > 50) {
      throw new BadRequestException("Maximum 50 grants per bulk request");
    }

    const results: Array<{ recipientUserId: string; result: any; error?: string }> = [];

    for (const grant of dto.grants) {
      try {
        const result = await this.createGrant(grantorId, grant);
        results.push({ recipientUserId: grant.recipientUserId, result });
      } catch (err: any) {
        results.push({
          recipientUserId: grant.recipientUserId,
          result: null,
          error: err.message,
        });
      }
    }

    return {
      total: dto.grants.length,
      success: results.filter((r) => r.result !== null).length,
      failed: results.filter((r) => r.result === null).length,
      results,
    };
  }

  /**
   * Get all active grants for the current user (for decryption).
   * The client uses these to decrypt files it has access to.
   * SECURITY: Filters out grants for team files the user no longer has access to.
   */
  async getMyGrants(userId: string, filters?: { fileId?: string; teamFileId?: string; shareId?: string }) {
    const where: any = { userId, status: "ACTIVE" };

    if (filters?.fileId) where.fileId = filters.fileId;
    if (filters?.teamFileId) where.teamFileId = filters.teamFileId;
    if (filters?.shareId) where.shareId = filters.shareId;

    const grants = await this.prisma.accessGrant.findMany({
      where,
      select: {
        id: true,
        encryptedFileKey: true,
        ephemeralPublicKey: true,
        nonce: true,
        algorithm: true,
        dekVersion: true,
        fileId: true,
        teamFileId: true,
        shareId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const visibleGrants = [];
    for (const grant of grants) {
      if (await this.canReadGrant(userId, grant)) {
        visibleGrants.push(grant);
      }
    }

    return visibleGrants;
  }

  /**
   * Get a specific grant for a file (used during download/decrypt).
   */
  async getGrantForFile(userId: string, fileId: string) {
    const grant = await this.prisma.accessGrant.findFirst({
      where: { userId, fileId, status: "ACTIVE" },
      orderBy: { dekVersion: "desc" }, // Latest DEK version
      select: {
        id: true,
        encryptedFileKey: true,
        ephemeralPublicKey: true,
        nonce: true,
        algorithm: true,
        dekVersion: true,
      },
    });

    if (!grant) {
      throw new NotFoundException("No active grant found for this file");
    }

    await this.ensureCurrentFileGrantAccess(userId, fileId);

    return grant;
  }

  /**
   * Get a specific grant for a team file.
   */
  async getGrantForTeamFile(userId: string, teamFileId: string) {
    const grant = await this.prisma.accessGrant.findFirst({
      where: { userId, teamFileId, status: "ACTIVE" },
      orderBy: { dekVersion: "desc" },
      select: {
        id: true,
        encryptedFileKey: true,
        ephemeralPublicKey: true,
        nonce: true,
        algorithm: true,
        dekVersion: true,
      },
    });

    if (!grant) {
      throw new NotFoundException("No active grant found for this team file");
    }

    await this.ensureCurrentTeamFileGrantAccess(userId, teamFileId);

    return grant;
  }

  /**
   * Revoke a grant. The encrypted DEK becomes inaccessible.
   * Note: If the user already decrypted and cached the DEK, we cannot
   * prevent access to already-downloaded content (inherent limitation).
   * For full revocation, DEK rotation is needed.
   */
  async revokeGrant(grantId: string, revokerId: string) {
    const grant = await this.prisma.accessGrant.findUnique({
      where: { id: grantId },
    });

    if (!grant) throw new NotFoundException("Grant not found");
    if (grant.status === "REVOKED") {
      throw new BadRequestException("Grant is already revoked");
    }

    // Only the grantor or a team admin/owner can revoke
    if (grant.grantorId !== revokerId) {
      // Check if revoker is team admin for team files
      if (grant.teamFileId) {
        const teamFile = await this.prisma.teamFile.findUnique({
          where: { id: grant.teamFileId },
          include: { folder: { include: { team: true } } },
        });
        if (teamFile) {
          const membership = await this.prisma.teamMember.findFirst({
            where: {
              userId: revokerId,
              teamId: teamFile.folder.teamId,
              isActive: true,
              role: { in: ["OWNER", "ADMIN"] },
            },
          });
          if (!membership) {
            throw new ForbiddenException("Only the grantor or a team admin can revoke grants");
          }
        }
      } else {
        throw new ForbiddenException("Only the grantor can revoke this grant");
      }
    }

    await this.prisma.accessGrant.update({
      where: { id: grantId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    void this.logTeamGrantEvent(
      revokerId,
      {
        recipientUserId: grant.userId,
        fileId: grant.fileId || undefined,
        teamFileId: grant.teamFileId || undefined,
        shareId: grant.shareId || undefined,
      },
      "E2E_GRANT_REVOKED",
      grant.id,
    );

    this.logger.log(`Grant revoked: ${grantId} by ${revokerId}`);
    return { id: grantId, status: "REVOKED" };
  }

  private async logTeamGrantEvent(
    actorId: string,
    target: {
      recipientUserId: string;
      fileId?: string;
      teamFileId?: string;
      shareId?: string;
    },
    action: string,
    grantId: string,
  ) {
    try {
      let teamId: string | null = null;
      let folderId: string | null = null;
      let fileName: string | null = null;

      if (target.teamFileId) {
        const file = await this.prisma.teamFile.findUnique({
          where: { id: target.teamFileId },
          select: {
            name: true,
            folderId: true,
            folder: { select: { teamId: true } },
          },
        });
        teamId = file?.folder.teamId || null;
        folderId = file?.folderId || null;
        fileName = file?.name || null;
      } else if (target.fileId) {
        const file = await this.prisma.file.findUnique({
          where: { id: target.fileId },
          select: {
            name: true,
            share: { select: { teamFolderId: true, teamFolder: { select: { teamId: true } } } },
          },
        });
        teamId = file?.share.teamFolder?.teamId || null;
        folderId = file?.share.teamFolderId || null;
        fileName = file?.name || null;
      } else if (target.shareId) {
        const share = await this.prisma.share.findUnique({
          where: { id: target.shareId },
          select: {
            name: true,
            teamFolderId: true,
            teamFolder: { select: { teamId: true } },
          },
        });
        teamId = share?.teamFolder?.teamId || null;
        folderId = share?.teamFolderId || null;
        fileName = share?.name || null;
      }

      if (!teamId) return;
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { email: true, username: true },
      });
      await this.prisma.teamAccessLog.create({
        data: {
          teamId,
          action,
          actorEmail: actor?.email || actorId,
          actorName: actor?.username,
          folderId,
          fileName,
          targetType: "ACCESS_GRANT",
          targetId: grantId,
          metadata: JSON.stringify({ recipientUserId: target.recipientUserId }),
        },
      });
    } catch (error) {
      this.logger.error?.(
        `Failed to write Team grant audit event: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Revoke all grants for a specific file (for DEK rotation).
   * After this, new grants with the new DEK must be created for each user.
   */
  async revokeAllGrantsForFile(fileId: string, revokerId: string) {
    // Verify revoker owns the file
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: { share: true },
    });

    if (!file) throw new NotFoundException("File not found");
    if (file.share.creatorId !== revokerId) {
      throw new ForbiddenException("Only the file owner can revoke all grants");
    }

    const result = await this.prisma.accessGrant.updateMany({
      where: { fileId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    this.logger.log(
      `All grants revoked for file ${fileId}: ${result.count} grants revoked`,
    );

    return { fileId, revokedCount: result.count };
  }

  /**
   * Revoke all grants for a team file (for DEK rotation or member removal).
   */
  async revokeAllGrantsForTeamFile(teamFileId: string, revokerId: string) {
    const teamFile = await this.prisma.teamFile.findUnique({
      where: { id: teamFileId },
      include: { folder: { include: { team: true } } },
    });

    if (!teamFile) throw new NotFoundException("Team file not found");

    // Only team owner/admin can revoke all
    const membership = await this.prisma.teamMember.findFirst({
      where: {
        userId: revokerId,
        teamId: teamFile.folder.teamId,
        isActive: true,
        role: { in: ["OWNER", "ADMIN"] },
      },
    });

    if (!membership) {
      throw new ForbiddenException("Only team owner/admin can revoke all grants for a team file");
    }

    const result = await this.prisma.accessGrant.updateMany({
      where: { teamFileId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    this.logger.log(
      `All grants revoked for team file ${teamFileId}: ${result.count} grants revoked`,
    );

    return { teamFileId, revokedCount: result.count };
  }

  /**
   * Get team shares: received (grants where I'm recipient) and sent (grants where I'm grantor),
   * scoped to team files within a specific team.
   * Supports both teamFileId-based grants AND fileId-based grants (via Share → teamFolder).
   */
  async getTeamShares(
    userId: string,
    teamId: string,
    options: { receivedPage?: number; sentPage?: number; limit?: number } = {},
  ) {
    await this.ensureActiveTeamMembership(userId, teamId);

    const receivedPage = Number.isFinite(options.receivedPage) && (options.receivedPage || 0) > 0
      ? Math.floor(options.receivedPage as number)
      : 1;
    const sentPage = Number.isFinite(options.sentPage) && (options.sentPage || 0) > 0
      ? Math.floor(options.sentPage as number)
      : 1;
    const limit = Number.isFinite(options.limit) && (options.limit || 0) > 0
      ? Math.min(Math.floor(options.limit as number), 100)
      : 25;

    const receivedWhere: Prisma.AccessGrantWhereInput = {
      userId,
      status: "ACTIVE",
      OR: [
        { teamFile: { folder: { teamId } } },
        { file: { share: { teamFolder: { teamId } } } },
      ],
    };
    const sentWhere: Prisma.AccessGrantWhereInput = {
      grantorId: userId,
      status: "ACTIVE",
      OR: [
        { teamFile: { folder: { teamId } } },
        { file: { share: { teamFolder: { teamId } } } },
      ],
    };

    // Received: grants where I'm the recipient, in this team
    // Case 1: via teamFile.folder.teamId
    // Case 2: via file.share.teamFolder.teamId
    const receivedQuery = this.prisma.accessGrant.findMany({
      where: receivedWhere,
      select: {
        id: true,
        createdAt: true,
        grantorId: true,
        teamFileId: true,
        fileId: true,
        teamFile: {
          select: {
            id: true,
            name: true,
            size: true,
            mimeType: true,
            folderId: true,
            folder: { select: { id: true, name: true } },
          },
        },
        file: {
          select: {
            id: true,
            name: true,
            size: true,
            share: {
              select: {
                id: true,
                teamFolderId: true,
                teamFolder: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (receivedPage - 1) * limit,
      take: limit,
    });

    // Sent: grants where I'm the grantor, in this team
    const sentQuery = this.prisma.accessGrant.findMany({
      where: sentWhere,
      select: {
        id: true,
        createdAt: true,
        userId: true,
        teamFileId: true,
        fileId: true,
        teamFile: {
          select: {
            id: true,
            name: true,
            size: true,
            mimeType: true,
            folderId: true,
            folder: { select: { id: true, name: true } },
          },
        },
        file: {
          select: {
            id: true,
            name: true,
            size: true,
            share: {
              select: {
                id: true,
                teamFolderId: true,
                teamFolder: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (sentPage - 1) * limit,
      take: limit,
    });

    const [received, sent, receivedTotal, sentTotal] = await Promise.all([
      receivedQuery,
      sentQuery,
      this.prisma.accessGrant.count({ where: receivedWhere }),
      this.prisma.accessGrant.count({ where: sentWhere }),
    ]);

    // Resolve user names for display
    const grantorIds = [...new Set(received.map((g) => g.grantorId))];
    const recipientIds = [...new Set(sent.map((g) => g.userId))];
    const allUserIds = [...new Set([...grantorIds, ...recipientIds])];

    const users = await this.prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: { id: true, username: true, email: true },
    });
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    // Normalize results: unify teamFile-based and file-based grants into a common shape
    const normalizeGrant = (g: any) => {
      if (g.teamFile) {
        return {
          fileId: g.teamFile.id,
          fileName: g.teamFile.name,
          fileSize: g.teamFile.size,
          mimeType: g.teamFile.mimeType,
          folderId: g.teamFile.folderId,
          folderName: g.teamFile.folder?.name || null,
        };
      }
      if (g.file) {
        return {
          fileId: g.file.id,
          fileName: g.file.name,
          fileSize: g.file.size,
          mimeType: null,
          folderId: g.file.share?.teamFolderId || null,
          folderName: g.file.share?.teamFolder?.name || null,
        };
      }
      return null;
    };

    return {
      received: received.map((g) => ({
        id: g.id,
        createdAt: g.createdAt,
        grantor: userMap[g.grantorId] || { username: "Inconnu", email: "" },
        fileInfo: normalizeGrant(g),
      })),
      sent: sent.map((g) => ({
        id: g.id,
        createdAt: g.createdAt,
        recipient: userMap[g.userId] || { username: "Inconnu", email: "" },
        fileInfo: normalizeGrant(g),
      })),
      pagination: {
        received: {
          page: receivedPage,
          limit,
          total: receivedTotal,
          totalPages: Math.ceil(receivedTotal / limit),
        },
        sent: {
          page: sentPage,
          limit,
          total: sentTotal,
          totalPages: Math.ceil(sentTotal / limit),
        },
      },
    };
  }

  /**
   * Validate that the grantor has access to the target resource.
   */
  private async validateGrantorAccess(grantorId: string, dto: CreateAccessGrantDTO) {
    if (dto.fileId) {
      const file = await this.prisma.file.findUnique({
        where: { id: dto.fileId },
        include: { share: { include: { teamFolder: true } } },
      });
      if (!file) throw new NotFoundException("File not found");

      // If the file belongs to a team folder, validate via team membership
      if (file.share.teamFolderId) {
        const teamId = file.share.teamFolder?.teamId;
        if (teamId) {
          const membership = await this.prisma.teamMember.findFirst({
            where: { userId: grantorId, teamId, isActive: true },
          });
          if (!membership) {
            throw new ForbiddenException("You are not a member of this team");
          }
          // OWNER/ADMIN have implicit full access
          if (!["OWNER", "ADMIN"].includes(membership.role)) {
            const folderAccess = await this.prisma.teamFolderAccess.findFirst({
              where: {
                memberId: membership.id,
                folderId: file.share.teamFolderId,
                permission: { in: ["WRITE", "ADMIN"] },
              },
            });
            if (!folderAccess) {
              throw new ForbiddenException(
                "You need WRITE access to the folder to grant file access",
              );
            }
            // Check canShareE2E permission
            if (!folderAccess.canShareE2E) {
              throw new ForbiddenException(
                "You do not have permission to share files with E2E encryption in this folder",
              );
            }
          }
        }
      } else if (file.share.creatorId !== grantorId) {
        throw new ForbiddenException("You don't have access to grant permissions on this file");
      }
    }

    if (dto.teamFileId) {
      const teamFile = await this.prisma.teamFile.findUnique({
        where: { id: dto.teamFileId },
        include: { folder: { include: { team: true } } },
      });
      if (!teamFile) throw new NotFoundException("Team file not found");

      // Must be team member with WRITE or ADMIN access
      const membership = await this.prisma.teamMember.findFirst({
        where: {
          userId: grantorId,
          teamId: teamFile.folder.teamId,
          isActive: true,
        },
      });
      if (!membership) {
        throw new ForbiddenException("You are not a member of this team");
      }

      // Check folder access
      const folderAccess = await this.prisma.teamFolderAccess.findFirst({
        where: {
          memberId: membership.id,
          folderId: teamFile.folderId,
          permission: { in: ["WRITE", "ADMIN"] },
        },
      });

      // Owner/Admin bypass
      if (!folderAccess && !["OWNER", "ADMIN"].includes(membership.role)) {
        throw new ForbiddenException(
          "You need WRITE access to the folder to grant file access",
        );
      }

      // Check canShareE2E permission (non-admin members)
      if (folderAccess && !["OWNER", "ADMIN"].includes(membership.role) && !folderAccess.canShareE2E) {
        throw new ForbiddenException(
          "You do not have permission to share files with E2E encryption in this folder",
        );
      }
    }

    if (dto.shareId && !dto.teamFileId && !dto.fileId) {
      // Only enforce share ownership when not already validated via teamFileId or fileId.
      // For team file grants that also carry a shareId, the team membership
      // check above is sufficient.
      const share = await this.prisma.share.findUnique({
        where: { id: dto.shareId },
        include: { teamFolder: true },
      });
      if (!share) throw new NotFoundException("Share not found");

      if (share.teamFolderId) {
        // Share belongs to a team folder - verify active membership + adequate role
        const teamId = share.teamFolder?.teamId;
        if (!teamId) throw new ForbiddenException("Invalid team folder");
        const membership = await this.prisma.teamMember.findFirst({
          where: { userId: grantorId, teamId, isActive: true },
        });
        if (!membership) {
          throw new ForbiddenException("You are not a member of this team");
        }
        if (!["OWNER", "ADMIN"].includes(membership.role)) {
          const folderAccess = await this.prisma.teamFolderAccess.findFirst({
            where: {
              memberId: membership.id,
              folderId: share.teamFolderId,
              permission: { in: ["WRITE", "ADMIN"] },
              canShareE2E: true,
            },
          });
          if (!folderAccess) {
            throw new ForbiddenException(
              "You need WRITE access with E2E sharing permission on this folder",
            );
          }
        }
      } else if (share.creatorId !== grantorId) {
        throw new ForbiddenException("You don't own this share");
      }
    }
  }

  private async canReadGrant(
    userId: string,
    grant: { fileId?: string | null; teamFileId?: string | null; shareId?: string | null },
  ) {
    try {
      if (grant.teamFileId) {
        await this.ensureCurrentTeamFileGrantAccess(userId, grant.teamFileId);
      } else if (grant.fileId) {
        await this.ensureCurrentFileGrantAccess(userId, grant.fileId);
      } else if (grant.shareId) {
        await this.ensureCurrentShareGrantAccess(userId, grant.shareId);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async ensureActiveTeamMembership(userId: string, teamId: string) {
    const membership = await this.prisma.teamMember.findFirst({
      where: { userId, teamId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException("You are not an active member of this team");
    }
    return membership;
  }

  private async ensureCurrentShareGrantAccess(userId: string, shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: {
        teamFolderId: true,
        teamFolder: { select: { teamId: true } },
      },
    });
    if (!share) throw new NotFoundException("Share not found");
    if (!share.teamFolderId) return;

    const teamId = share.teamFolder?.teamId;
    if (!teamId) throw new ForbiddenException("Invalid team folder");
    const membership = await this.ensureActiveTeamMembership(userId, teamId);
    if (["OWNER", "ADMIN"].includes(membership.role)) return;

    const folderAccess = await this.prisma.teamFolderAccess.findFirst({
      where: {
        memberId: membership.id,
        folderId: share.teamFolderId,
        permission: { in: ["READ", "WRITE", "ADMIN"] },
        canDownload: true,
      },
    });
    if (!folderAccess) {
      throw new ForbiddenException("You no longer have access to this share");
    }
  }

  private async ensureCurrentFileGrantAccess(userId: string, fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        share: {
          select: {
            teamFolderId: true,
            teamFolder: { select: { teamId: true } },
          },
        },
      },
    });
    if (!file) throw new NotFoundException("File not found");
    if (!file.share.teamFolderId) return;

    const teamId = file.share.teamFolder?.teamId;
    if (!teamId) throw new ForbiddenException("Invalid team folder");
    const membership = await this.ensureActiveTeamMembership(userId, teamId);
    if (["OWNER", "ADMIN"].includes(membership.role)) return;

    const explicitFileAccess = await this.prisma.fileAccess.findUnique({
      where: {
        memberId_fileId: {
          memberId: membership.id,
          fileId,
        },
      },
    });

    if (explicitFileAccess?.permission === "DENY") {
      throw new ForbiddenException("You no longer have access to this file");
    }
    if (
      explicitFileAccess &&
      ["READ", "WRITE", "ADMIN"].includes(explicitFileAccess.permission)
    ) {
      return;
    }

    const folderAccess = await this.prisma.teamFolderAccess.findUnique({
      where: {
        memberId_folderId: {
          memberId: membership.id,
          folderId: file.share.teamFolderId,
        },
      },
    });

    if (
      !folderAccess ||
      !folderAccess.canDownload ||
      !["READ", "WRITE", "ADMIN"].includes(folderAccess.permission)
    ) {
      throw new ForbiddenException("You no longer have access to this file");
    }
  }

  private async ensureCurrentTeamFileGrantAccess(
    userId: string,
    teamFileId: string,
  ) {
    const teamFile = await this.prisma.teamFile.findUnique({
      where: { id: teamFileId },
      select: {
        folderId: true,
        folder: { select: { teamId: true } },
      },
    });
    if (!teamFile) throw new NotFoundException("Team file not found");

    const membership = await this.ensureActiveTeamMembership(
      userId,
      teamFile.folder.teamId,
    );
    if (["OWNER", "ADMIN"].includes(membership.role)) return;

    const folderAccess = await this.prisma.teamFolderAccess.findUnique({
      where: {
        memberId_folderId: {
          memberId: membership.id,
          folderId: teamFile.folderId,
        },
      },
    });

    if (
      !folderAccess ||
      !folderAccess.canDownload ||
      !["READ", "WRITE", "ADMIN"].includes(folderAccess.permission)
    ) {
      throw new ForbiddenException("You no longer have access to this team file");
    }
  }
}
