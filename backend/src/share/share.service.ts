import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import { Prisma, Share, User } from "@prisma/client";
import * as argon from "argon2";
import * as fs from "fs";
import * as path from "path";
import moment from "moment";
import { ClamScanService } from "src/clamscan/clamscan.service";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import { PushService } from "src/push/push.service";
import { ReverseShareService } from "src/reverseShare/reverseShare.service";
import { parseRelativeDateToAbsolute } from "src/utils/date.util";
import { SHARE_DIRECTORY } from "../constants";
import { getArchiveEntryName } from "../file/file-path.util";
import { createZipArchive } from "../utils/archive.util";
import { CreateShareDTO } from "./dto/createShare.dto";

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private fileService: FileService,
    private emailService: EmailService,
    private config: ConfigService,
    private jwtService: JwtService,
    private reverseShareService: ReverseShareService,
    private clamScanService: ClamScanService,
    private pushService: PushService,
  ) {}

  async create(share: CreateShareDTO, user?: User, reverseShareToken?: string) {
    if (!(await this.isShareIdAvailable(share.id)).isAvailable)
      throw new BadRequestException("Share id already in use");

    this.logger.debug(
      `Creating share: shareId=${share.id} userId=${user?.id ?? "anonymous"} reverseShareToken=${reverseShareToken ? "provided" : "none"}`,
    );

    const hasSecurity =
      !!share.security && Object.keys(share.security).length > 0;
    const hasPassword = !!share.security?.password;

    if (!hasSecurity) {
      this.logger.debug(`No security provided: shareId=${share.id}`);
      share.security = undefined;
    } else {
      this.logger.debug(
        `Security provided: shareId=${share.id} passwordProtected=${hasPassword} maxViews=${share.security?.maxViews ?? "none"}`,
      );
    }
    if (hasPassword) {
      this.logger.debug(`Hashing password: shareId=${share.id}`);
      share.security.password = await argon.hash(share.security.password);
    }

    let expirationDate: Date;

    // If share is created by a reverse share token override the expiration date
    const reverseShare =
      await this.reverseShareService.getByToken(reverseShareToken);
    if (reverseShare && moment(reverseShare.shareExpiration).unix() !== 0) {
      // RS with a finite expiration: use it directly
      expirationDate = reverseShare.shareExpiration;
      this.logger.debug(
        `Using reverse share expiration: shareId=${share.id} reverseShareToken=provided expiration=${expirationDate.toISOString()}`,
      );
    } else {
      const parsedExpiration = parseRelativeDateToAbsolute(share.expiration);
      const expiresNever = moment(0).toDate() == parsedExpiration;
      const isPermanentRS =
        reverseShare && moment(reverseShare.shareExpiration).unix() === 0;

      // Enforce stricter limits for anonymous (unauthenticated) shares
      if (!user) {
        const anonMax = this.config.get("share.anonymousMaxExpiration");
        if (anonMax.value !== 0) {
          const anonMaxDate = moment()
            .add(anonMax.value, anonMax.unit)
            .toDate();
          if (expiresNever || parsedExpiration > anonMaxDate) {
            this.logger.warn(
              `Anonymous share expiration exceeds limit: shareId=${share.id} requested=${expiresNever ? "never" : parsedExpiration.toISOString()} max=${anonMaxDate.toISOString()}`,
            );
            throw new BadRequestException(
              "Anonymous shares cannot exceed the maximum allowed expiration",
            );
          }
        }
      }

      // Global share.maxExpiration only applies to anonymous shares or as a
      // reverse-share clamp. Authenticated shares are unlimited by default.
      if (!user) {
        const maxExpiration = this.config.get("share.maxExpiration");
        if (maxExpiration.value !== 0) {
          const maxExpiryDate = moment()
            .add(maxExpiration.value, maxExpiration.unit)
            .toDate();
          if (expiresNever || parsedExpiration > maxExpiryDate) {
            this.logger.warn(
              `Expiration exceeds maximum: shareId=${share.id} requested=${parsedExpiration.toISOString()} max=${maxExpiryDate.toISOString()}`,
            );
            throw new BadRequestException(
              "Expiration date exceeds maximum expiration date",
            );
          }
        }
        expirationDate = parsedExpiration;
      } else if (isPermanentRS) {
        expirationDate = parsedExpiration;
      } else {
        expirationDate = parsedExpiration;
      }
    }

    // [UX/Security] Defense-in-depth: when the share is created via a
    // reverse share token, the uploader must NOT be allowed to:
    //  - set recipients (would forward files to unintended third parties)
    //  - set maxViews (the uploader could exhaust views before the creator)
    // Password is intentionally KEPT: it adds a layer of security that
    // can reassure the external user receiving the reverse share link.
    // The frontend hides recipients and maxViews for reverse share uploads,
    // but a crafted API request could still include them.
    if (reverseShare) {
      if (share.recipients?.length) {
        this.logger.warn(
          `Stripped recipients from reverse share upload: shareId=${share.id} count=${share.recipients.length}`,
        );
      }
      if (share.security?.maxViews) {
        this.logger.warn(
          `Stripped maxViews from reverse share upload: shareId=${share.id}`,
        );
      }
      share.recipients = [];
      if (share.security) {
        share.security = { password: share.security.password } as any;
      }
    }

    // --- Team folder assignment: verify membership & folder access ---
    let teamFolderConnect: { id: string } | undefined;
    if (share.teamFolderId) {
      if (!user) {
        throw new ForbiddenException(
          "Anonymous users cannot share to a team folder",
        );
      }
      // Verify the folder exists and get the team info
      const folder = await this.prisma.teamFolder.findUnique({
        where: { id: share.teamFolderId },
        include: {
          team: { include: { members: true } },
          accessRules: true,
        },
      });
      if (!folder) {
        throw new NotFoundException("Team folder not found");
      }
      if (share.isE2EEncrypted) {
        const activeRotation = await this.prisma.teamKeyRotation.findFirst({
          where: {
            teamId: folder.teamId,
            status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
          },
          select: { id: true },
        });
        if (activeRotation) {
          throw new ConflictException(
            "Team E2E uploads are temporarily paused while key rotation is in progress",
          );
        }
      }
      // Check user is a member of the team that owns this folder
      const membership = folder.team.members.find((m) => m.userId === user.id);
      if (!membership || !membership.isActive) {
        throw new ForbiddenException("You are not a member of this team");
      }
      // Check the member has at least WRITE access to the folder
      const accessRule = folder.accessRules.find(
        (a) => a.memberId === membership.id,
      );
      const memberRole = membership.role;
      // OWNER and ADMIN have implicit full access; others need explicit WRITE or ADMIN
      if (
        memberRole !== "OWNER" &&
        memberRole !== "ADMIN" &&
        (!accessRule || !["WRITE", "ADMIN"].includes(accessRule.permission))
      ) {
        throw new ForbiddenException(
          "You do not have write access to this team folder",
        );
      }
      this.logger.debug(
        `Team folder validated: shareId=${share.id} teamFolderId=${share.teamFolderId} teamId=${folder.teamId} userId=${user.id}`,
      );
      teamFolderConnect = { id: share.teamFolderId };
    }

    fs.mkdirSync(`${SHARE_DIRECTORY}/${share.id}`, {
      recursive: true,
    });
    this.logger.debug(
      `Ensured share directory: shareId=${share.id} path=${SHARE_DIRECTORY}/${share.id}`,
    );

    const storageProvider = this.configService.get("s3.enabled")
      ? "S3"
      : "LOCAL";
    this.logger.debug(
      `Selected storage provider: shareId=${share.id} provider=${storageProvider}`,
    );

    const { teamFolderId: _tfId, ...shareData } = share;

    const shareTuple = await this.prisma.share.create({
      data: {
        ...shareData,
        expiration: expirationDate,
        creator: { connect: user ? { id: user.id } : undefined },
        security: { create: share.security },
        recipients: {
          create: share.recipients
            ? share.recipients.map((email) => ({ email }))
            : [],
        },
        storageProvider: this.configService.get("s3.enabled") ? "S3" : "LOCAL",
        ...(teamFolderConnect && {
          teamFolder: { connect: teamFolderConnect },
        }),
      },
    });

    this.logger.debug(
      `Share created: shareId=${share.id} userId=${user?.id ?? "anonymous"} recipients=${share.recipients?.length ?? 0} storage=${storageProvider} expires=${expirationDate.toISOString()}`,
    );

    // Log team activity for team-folder uploads
    if (teamFolderConnect && user) {
      const folder = await this.prisma.teamFolder.findUnique({
        where: { id: teamFolderConnect.id },
        select: { teamId: true, name: true },
      });
      if (folder) {
        this.logger.log(`Logging UPLOAD for team ${folder.teamId}`);
        this.prisma.teamAccessLog
          .create({
            data: {
              teamId: folder.teamId,
              action: "UPLOAD",
              actorEmail: user.email,
              actorName: user.username || undefined,
              fileName: share.id,
              folderId: teamFolderConnect.id,
            },
          })
          .catch((err) =>
            this.logger.error(`Failed to log UPLOAD: ${err.message}`),
          );
      }
    }

    if (reverseShare) {
      // Assign share to reverse share token
      await this.prisma.reverseShare.update({
        where: { token: reverseShareToken },
        data: {
          shares: {
            connect: { id: shareTuple.id },
          },
        },
      });
    }

    return shareTuple;
  }

  async createZip(shareId: string) {
    if (this.config.get("s3.enabled")) return;

    // CWE-23: resolve + prefix check to prevent path traversal
    const baseDir = path.resolve(SHARE_DIRECTORY);
    const sharePath = path.resolve(SHARE_DIRECTORY, shareId);
    if (!sharePath.startsWith(baseDir + path.sep)) {
      throw new BadRequestException("Invalid share identifier");
    }

    const files = await this.prisma.file.findMany({ where: { shareId } });
    const archive = createZipArchive({
      zlib: { level: this.config.get("share.zipCompressionLevel") },
    });
    const writeStream = fs.createWriteStream(
      path.join(sharePath, "archive.zip"),
    );

    for (const file of files) {
      const filePath = path.resolve(sharePath, file.id);
      if (!filePath.startsWith(sharePath + path.sep)) {
        this.logger.warn(`Skipping suspicious file id: ${file.id}`);
        continue;
      }
      let archiveName: string;
      try {
        archiveName = getArchiveEntryName(file);
      } catch {
        this.logger.warn(
          `Skipping file with unsafe archive path: shareId=${shareId} fileId=${file.id}`,
        );
        continue;
      }
      archive.append(fs.createReadStream(filePath), {
        name: archiveName,
      });
    }

    archive.pipe(writeStream);
    await archive.finalize();
    this.logger.debug(`Created zip: shareId=${shareId}`);
  }

  async complete(id: string, reverseShareToken?: string, e2eKey?: string) {
    this.logger.debug(
      `Completing share: shareId=${id} reverseShareToken=${reverseShareToken ? "provided" : "none"} e2eKeyProvided=${!!e2eKey}`,
    );

    const share = await this.prisma.share.findUnique({
      where: { id },
      include: {
        files: true,
        recipients: true,
        creator: true,
        reverseShare: { include: { creator: true } },
      },
    });

    if (!share) {
      this.logger.warn(`Share not found on complete: shareId=${id}`);
      throw new NotFoundException("Share not found");
    }

    const notifyReverseShareCreator = share.reverseShare
      ? this.config.get("smtp.enabled") &&
        share.reverseShare.sendEmailNotification
      : undefined;
    const completedShareResponse = (completedShare: Share) => ({
      ...completedShare,
      notifyReverseShareCreator,
    });

    if (share.uploadLocked) {
      this.logger.debug(
        `Share already completed, returning existing share: shareId=${id}`,
      );
      return completedShareResponse(share);
    }

    if (share.files.length === 0) {
      this.logger.warn(`Attempt to complete without files: shareId=${id}`);
      throw new BadRequestException(
        "You need at least on file in your share to complete it.",
      );
    }

    const completionClaim = await this.prisma.share.updateMany({
      where: { id, uploadLocked: false },
      data: { uploadLocked: true },
    });
    if (completionClaim.count === 0) {
      const completedShare = await this.prisma.share.findUnique({
        where: { id },
      });
      if (!completedShare) {
        throw new NotFoundException("Share not found");
      }
      this.logger.debug(`Share completion already claimed: shareId=${id}`);
      return completedShareResponse(completedShare);
    }

    const shouldCreateZip =
      share.files.length > 1 || share.files.some((file) => !!file.relativePath);

    // Asynchronously create a zip of all files.
    // Skip ZIP for E2E encrypted shares (server can't read encrypted content).
    // A one-file folder upload still needs a ZIP to preserve its parent path.
    if (shouldCreateZip && !share.isE2EEncrypted) {
      this.logger.debug(
        `Scheduling zip creation: shareId=${id} fileCount=${share.files.length}`,
      );
      this.createZip(id)
        .then(async () => {
          await this.prisma.share.update({
            where: { id },
            data: { isZipReady: true },
          });
          this.logger.debug(`Zip ready: shareId=${id}`);
        })
        .catch((err) => {
          this.logger.error(
            `Zip creation failed: shareId=${id} error=${(err as Error).message}`,
          );
        });
    }

    // Send email for each recipient
    const recipientCount = share.recipients.length;
    // Only include the E2E key in the email if the global admin setting allows it
    const e2eKeyForEmail =
      e2eKey && this.config.get("email.enableE2EKeyEmailSharing")
        ? e2eKey
        : undefined;
    if (recipientCount > 0 && this.config.get("smtp.enabled")) {
      this.logger.debug(
        `Sending recipient emails: shareId=${id} recipients=${recipientCount} e2eKeyInEmail=${!!e2eKeyForEmail}`,
      );
      for (const recipient of share.recipients) {
        try {
          await this.emailService.sendMailToShareRecipients(
            recipient.email,
            share.id,
            share.creator,
            share.name,
            share.description,
            share.expiration,
            e2eKeyForEmail,
          );
          this.logger.debug(
            `Recipient email sent: shareId=${id} recipient=${recipient.email}`,
          );
        } catch (err) {
          // Log and continue sending to others
          this.logger.error(
            `Recipient email failed: shareId=${id} recipient=${recipient.email} error=${(err as Error).message}`,
          );
        }
      }
    } else {
      this.logger.debug(
        `Skipping recipient emails: shareId=${id} recipients=${recipientCount} smtpEnabled=${this.config.get("smtp.enabled")}`,
      );
    }

    if (notifyReverseShareCreator) {
      try {
        // The reverse share creator owns K_rs - always include it in the email
        // so they can decrypt their files. This is NOT gated by
        // enableE2EKeyEmailSharing (that setting controls sharing K with
        // third-party recipients, not with the key owner).
        await this.emailService.sendMailToReverseShareCreator(
          share.reverseShare.creator.email,
          share.id,
          e2eKey,
        );
        this.logger.debug(`Reverse share creator notified: shareId=${id}`);
      } catch (err) {
        this.logger.error(
          `Reverse share notification failed: shareId=${id} error=${(err as Error).message}`,
        );
      }
    }

    // Send push notification to reverse share creator
    if (share.reverseShare) {
      const appName = this.config.get("general.appName");
      void this.pushService.sendToUser(share.reverseShare.creatorId, {
        title: appName,
        body: `A new share "${share.name || id}" was uploaded via your reverse share link.`,
        url: `/share/${id}`,
      });
    }

    // Send push notification to share creator (for regular shares)
    if (share.creatorId && !share.reverseShare) {
      const appName = this.config.get("general.appName");
      void this.pushService.sendToUser(share.creatorId, {
        title: appName,
        body: `Your share "${share.name || id}" is ready.`,
        url: `/share/${id}`,
      });
    }

    // Check if any file is malicious with ClamAV
    // Skip ClamAV for E2E encrypted shares (can't scan encrypted content)
    if (!share.isE2EEncrypted) {
      this.logger.debug(`Scheduling malware scan: shareId=${id}`);
      void this.clamScanService.checkAndRemove(share.id);
    } else {
      this.logger.debug(`Skipping malware scan (E2E encrypted): shareId=${id}`);
    }

    // Decrement reverse share remaining uses if applicable
    // Personal links (epoch 0 = never expires) have unlimited uses
    if (share.reverseShare) {
      const isPersonal = share.reverseShare.shareExpiration.getTime() === 0;
      if (!isPersonal) {
        try {
          await this.prisma.reverseShare.update({
            where: { token: reverseShareToken },
            data: { remainingUses: { decrement: 1 } },
          });
          this.logger.debug(
            `Reverse share remainingUses decremented: shareId=${id}`,
          );
        } catch (err) {
          this.logger.error(
            `Failed to decrement reverse share uses: shareId=${id} error=${(err as Error).message}`,
          );
        }
      }
    }

    const updatedShare = await this.prisma.share.findUnique({
      where: { id },
    });
    if (!updatedShare) {
      throw new NotFoundException("Share not found");
    }
    this.logger.debug(
      `Share completed: shareId=${id} files=${share.files.length} recipients=${recipientCount} uploadLocked=true`,
    );

    return completedShareResponse(updatedShare);
  }

  async revertComplete(id: string) {
    this.logger.debug(`Revert completion of share: shareId=${id}`);
    return this.prisma.share.update({
      where: { id },
      data: {
        uploadLocked: false,
        isZipReady: false,
        // Reset createdAt so the deleteUnfinishedShares cron job
        // (which deletes shares with uploadLocked=false older than 24h)
        // won't remove this share while it is being edited.
        createdAt: new Date(),
      },
    });
  }

  async getShares() {
    const shares = await this.prisma.share.findMany({
      orderBy: {
        expiration: "desc",
      },
      include: { files: true, creator: true },
    });

    return shares.map((share) => {
      return {
        ...share,
        size: share.files.reduce((acc, file) => acc + parseInt(file.size), 0),
      };
    });
  }

  async getStoredRecipientsByUser(userId: string, query?: string) {
    const recipients = await this.prisma.shareRecipient.findMany({
      where: {
        share: {
          creatorId: userId,
        },
        email: {
          contains: query,
        },
      },
      orderBy: {
        email: "asc",
      },
      select: {
        email: true,
      },
      distinct: Prisma.ShareRecipientScalarFieldEnum.email,
    });

    return recipients.map((recipient) => recipient.email);
  }

  async getSharesByUser(userId: string) {
    const shares = await this.prisma.share.findMany({
      where: {
        creator: { id: userId },
        // Team-folder shares are managed from the team workspace. Keeping them
        // out of /account/shares avoids opening encrypted team files through
        // the personal-share path, where the team key is not available.
        teamFolderId: null,
        uploadLocked: true,
        // We want to grab any shares that are not expired or have their expiration date set to "never" (unix 0)
        OR: [
          { expiration: { gt: new Date() } },
          { expiration: { equals: moment(0).toDate() } },
        ],
      },
      orderBy: {
        expiration: "desc",
      },
      include: { recipients: true, files: true, security: true },
    });

    return shares.map((share) => {
      return {
        ...share,
        size: share.files.reduce((acc, file) => acc + parseInt(file.size), 0),
        recipients: share.recipients.map((recipients) => recipients.email),
        security: {
          maxViews: share.security?.maxViews,
          passwordProtected: !!share.security?.password,
        },
      };
    });
  }

  async get(id: string): Promise<unknown> {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: {
        files: {
          orderBy: {
            name: "asc",
          },
        },
        creator: true,
        security: true,
        reverseShare: true,
        teamFolder: true,
      },
    });

    if (share.removedReason)
      throw new NotFoundException(share.removedReason, "share_removed");

    if (!share || !share.uploadLocked)
      throw new NotFoundException("Share not found");

    const previewEnabled = true;

    return {
      ...share,
      hasPassword: !!share.security?.password,
      previewEnabled,
      // Expose the encrypted reverse share key (K_rs wrapped by K_master).
      // It is AES-GCM ciphertext - useless without K_master, safe to expose.
      encryptedReverseShareKey:
        share.reverseShare?.encryptedReverseShareKey ?? null,
      // Expose team context so the frontend can resolve K_team instead of K_master
      teamFolderId: share.teamFolderId ?? null,
      teamId: share.teamFolder?.teamId ?? null,
    };
  }

  /**
   * Same as get() but allows access to shares that are temporarily unlocked
   * (uploadLocked=false) during editing.  Only used by the owner endpoint.
   */
  async getForOwner(id: string): Promise<unknown> {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: {
        files: {
          orderBy: {
            name: "asc",
          },
        },
        creator: true,
        security: true,
        reverseShare: true,
      },
    });

    if (!share) throw new NotFoundException("Share not found");

    if (share.removedReason)
      throw new NotFoundException(share.removedReason, "share_removed");

    const previewEnabled = true;

    return {
      ...share,
      hasPassword: !!share.security?.password,
      previewEnabled,
      encryptedReverseShareKey:
        share.reverseShare?.encryptedReverseShareKey ?? null,
    };
  }

  async getMetaData(id: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
    });

    if (!share || !share.uploadLocked)
      throw new NotFoundException("Share not found");

    return share;
  }

  /**
   * Retrieve the encrypted reverse share key (K_rs wrapped by K_master)
   * and the creator ID for ownership verification.
   * Returns null if the share has no parent reverse share or no E2E key.
   */
  async getEncryptedReverseShareKey(
    shareId: string,
  ): Promise<{ encryptedReverseShareKey: string; creatorId: string } | null> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { reverseShare: true },
    });

    if (!share) return null; // Share was deleted - caller handles null gracefully

    if (!share.reverseShare || !share.reverseShare.encryptedReverseShareKey) {
      return null;
    }

    return {
      encryptedReverseShareKey: share.reverseShare.encryptedReverseShareKey,
      creatorId: share.reverseShare.creatorId,
    };
  }

  async remove(shareId: string, isDeleterAdmin = false) {
    this.logger.debug(
      `Removing share: shareId=${shareId} isDeleterAdmin=${isDeleterAdmin}`,
    );
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    if (!share) {
      this.logger.warn(`Share not found on remove: shareId=${shareId}`);
      throw new NotFoundException("Share not found");
    }

    // Anonymous shares can only be deleted by admins
    if (!share.creatorId && !isDeleterAdmin) {
      this.logger.warn(
        `Forbidden remove for anonymous share: shareId=${shareId}`,
      );
      throw new ForbiddenException("Anonymous shares can't be deleted");
    }

    // Delete files first; if it fails, abort DB deletion
    try {
      await this.fileService.deleteAllFiles(shareId);
      this.logger.debug(`All files deleted: shareId=${shareId}`);
    } catch (err) {
      this.logger.error(
        `File deletion failed: shareId=${shareId} error=${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        "Failed to delete all files of the share. Share has not been removed.",
      );
    }

    // Only if files deletion succeeded, remove DB record
    await this.prisma.share.delete({ where: { id: shareId } });

    // Log team activity if this share belonged to a team folder
    if (share.teamFolderId) {
      const folder = await this.prisma.teamFolder.findUnique({
        where: { id: share.teamFolderId },
      });
      if (folder) {
        this.logger.log(`Logging SHARE_DELETE for team ${folder.teamId}`);
        this.prisma.teamAccessLog
          .create({
            data: {
              teamId: folder.teamId,
              action: "SHARE_DELETE",
              actorEmail: share.creatorId ? "owner" : "admin",
              fileName: share.name || shareId,
              folderId: share.teamFolderId,
            },
          })
          .catch((err) =>
            this.logger.error(`Failed to log SHARE_DELETE: ${err.message}`),
          );
      }
    }

    this.logger.debug(
      `Share removed: shareId=${shareId} deletedBy=${share.creatorId ? "owner_or_user" : isDeleterAdmin ? "admin" : "unknown"}`,
    );
  }

  async isShareCompleted(id: string) {
    return (await this.prisma.share.findUnique({ where: { id } })).uploadLocked;
  }

  async isShareIdAvailable(id: string) {
    const share = await this.prisma.share.findUnique({ where: { id } });
    return { isAvailable: !share };
  }

  async increaseViewCount(share: Share) {
    await this.prisma.share.update({
      where: { id: share.id },
      data: { views: share.views + 1 },
    });
  }

  async getShareToken(shareId: string, password: string) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      include: {
        security: true,
      },
    });

    if (share?.security?.password) {
      if (!password) {
        throw new ForbiddenException(
          "This share is password protected",
          "share_password_required",
        );
      }

      const isPasswordValid = await argon.verify(
        share.security.password,
        password,
      );
      if (!isPasswordValid) {
        throw new ForbiddenException("Wrong password", "wrong_password");
      }
    }

    if (share.security?.maxViews && share.security.maxViews <= share.views) {
      throw new ForbiddenException(
        "Maximum views exceeded",
        "share_max_views_exceeded",
      );
    }

    const token = await this.generateShareToken(shareId);
    await this.increaseViewCount(share);
    return token;
  }

  async generateShareToken(shareId: string) {
    const { expiration, createdAt } = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    const tokenPayload = {
      shareId,
      shareCreatedAt: moment(createdAt).unix(),
      iat: moment().unix(),
    };

    const tokenOptions: JwtSignOptions = {
      secret: this.config.get("internal.jwtSecret"),
    };

    if (!moment(expiration).isSame(0)) {
      tokenOptions.expiresIn = moment(expiration).diff(new Date(), "seconds");
    }

    return this.jwtService.sign(tokenPayload, tokenOptions);
  }

  async verifyShareToken(shareId: string, token: string) {
    const { expiration, createdAt } = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    try {
      const claims = this.jwtService.verify(token, {
        secret: this.config.get("internal.jwtSecret"),
        // Ignore expiration if expiration is 0
        ignoreExpiration: moment(expiration).isSame(0),
      });

      return (
        claims.shareId == shareId &&
        claims.shareCreatedAt == moment(createdAt).unix()
      );
    } catch {
      return false;
    }
  }
}
