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
import * as crypto from "crypto";
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
import {
  FILE_META_V1,
  isFileMetaWriteEnabledFor,
} from "../file/file-metadata-scheme";
import { createZipArchive } from "../utils/archive.util";
import { CreateShareDTO } from "./dto/createShare.dto";
import {
  LEGACY_ACCOUNT_KEY,
  SHARE_DEK_V1,
  SHARE_KEY_WRAP_ALGORITHM,
  isShareDekReadEnabled,
  isShareDekWriteEnabledFor,
  resolveShareCryptoScheme,
  shareCryptoSchemeName,
} from "./share-crypto-scheme";
import { normalizeShareRecipients } from "./share-recipient.util";
import { touchShareUploadActivity } from "./upload-activity.util";

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

  /**
   * Validate the personal key scheme requested by the client and return the
   * columns to store. Only an authenticated owner's personal E2E share can
   * use SHARE_DEK_V1: team shares keep K_team and reverse-share uploads keep
   * K_rs. Clients that send nothing keep the historical NULL value.
   */
  resolveCreateCryptoData(
    share: Pick<
      CreateShareDTO,
      | "id"
      | "isE2EEncrypted"
      | "cryptoScheme"
      | "wrappedShareKey"
      | "wrappedShareKeyAlgorithm"
      | "fileMetadataScheme"
    >,
    user: Pick<User, "id" | "email"> | undefined,
    isReverseShareUpload: boolean,
    isTeamShare: boolean,
  ): {
    cryptoScheme: number | null;
    wrappedShareKey: string | null;
    wrappedShareKeyAlgorithm: string | null;
    wrappedShareKeyVersion: number | null;
    fileMetadataScheme: number | null;
  } {
    const keyData = this.resolveCreateKeyData(
      share,
      user,
      isReverseShareUpload,
      isTeamShare,
    );
    if (
      share.fileMetadataScheme === undefined ||
      share.fileMetadataScheme === null
    ) {
      return { ...keyData, fileMetadataScheme: null };
    }
    if (share.fileMetadataScheme !== FILE_META_V1) {
      throw new BadRequestException(
        `Unsupported file metadata scheme: ${share.fileMetadataScheme}`,
      );
    }
    if (keyData.cryptoScheme !== SHARE_DEK_V1) {
      throw new BadRequestException(
        "Encrypted file names require cryptoScheme SHARE_DEK_V1",
      );
    }
    if (!isFileMetaWriteEnabledFor(user)) {
      this.logger.warn(
        `Share file names refused: share=redacted fileMetadataScheme=FILE_META_V1 reason=write_disabled`,
      );
      throw new ConflictException(
        "Encrypted file names are not enabled for this account",
        "file_metadata_scheme_unavailable",
      );
    }
    return { ...keyData, fileMetadataScheme: FILE_META_V1 };
  }

  private resolveCreateKeyData(
    share: Pick<
      CreateShareDTO,
      | "id"
      | "isE2EEncrypted"
      | "cryptoScheme"
      | "wrappedShareKey"
      | "wrappedShareKeyAlgorithm"
    >,
    user: Pick<User, "id" | "email"> | undefined,
    isReverseShareUpload: boolean,
    isTeamShare: boolean,
  ): {
    cryptoScheme: number | null;
    wrappedShareKey: string | null;
    wrappedShareKeyAlgorithm: string | null;
    wrappedShareKeyVersion: number | null;
  } {
    const legacy = {
      cryptoScheme: null,
      wrappedShareKey: null,
      wrappedShareKeyAlgorithm: null,
      wrappedShareKeyVersion: null,
    };
    const hasWrappedKey =
      share.wrappedShareKey !== undefined ||
      share.wrappedShareKeyAlgorithm !== undefined;

    if (share.cryptoScheme === undefined || share.cryptoScheme === null) {
      if (hasWrappedKey) {
        throw new BadRequestException(
          "A wrapped share key requires cryptoScheme SHARE_DEK_V1",
        );
      }
      return legacy;
    }

    const scheme = resolveShareCryptoScheme(share.cryptoScheme);
    const isPersonalE2E =
      !!user && !!share.isE2EEncrypted && !isReverseShareUpload && !isTeamShare;

    if (scheme === LEGACY_ACCOUNT_KEY) {
      if (hasWrappedKey) {
        throw new BadRequestException(
          "LEGACY_ACCOUNT_KEY shares cannot carry a wrapped share key",
        );
      }
      return isPersonalE2E
        ? { ...legacy, cryptoScheme: LEGACY_ACCOUNT_KEY }
        : legacy;
    }

    if (!isPersonalE2E) {
      throw new BadRequestException(
        "SHARE_DEK_V1 is only available for personal end-to-end encrypted shares",
      );
    }
    if (
      !share.wrappedShareKey ||
      share.wrappedShareKeyAlgorithm !== SHARE_KEY_WRAP_ALGORITHM
    ) {
      throw new BadRequestException(
        "SHARE_DEK_V1 requires a wrapped share key and its algorithm",
      );
    }
    if (!isShareDekReadEnabled() || !isShareDekWriteEnabledFor(user)) {
      this.logger.warn(
        `Share crypto refused: share=redacted cryptoScheme=SHARE_DEK_V1 reason=write_disabled`,
      );
      throw new ConflictException(
        "SHARE_DEK_V1 is not enabled for this account",
        "share_crypto_scheme_unavailable",
      );
    }
    return {
      cryptoScheme: SHARE_DEK_V1,
      wrappedShareKey: share.wrappedShareKey,
      wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
      wrappedShareKeyVersion: 1,
    };
  }

  async create(share: CreateShareDTO, user?: User, reverseShareToken?: string) {
    if (!(await this.isShareIdAvailable(share.id)).isAvailable)
      throw new BadRequestException("Share id already in use");

    this.logger.debug(
      `Creating share: share=redacted userId=${user?.id ?? "anonymous"} reverseShareToken=${reverseShareToken ? "provided" : "none"}`,
    );

    const hasSecurity =
      !!share.security && Object.keys(share.security).length > 0;
    const hasPassword = !!share.security?.password;

    if (!hasSecurity) {
      share.security = undefined;
    }
    if (hasPassword) {
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
        `Using reverse share expiration: share=redacted reverseShareToken=provided expiration=${expirationDate.toISOString()}`,
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
              `Anonymous share expiration exceeds limit: share=redacted requested=${expiresNever ? "never" : parsedExpiration.toISOString()} max=${anonMaxDate.toISOString()}`,
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
              `Expiration exceeds maximum: share=redacted requested=${parsedExpiration.toISOString()} max=${maxExpiryDate.toISOString()}`,
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
          `Stripped recipients from reverse share upload: share=redacted count=${share.recipients.length}`,
        );
      }
      if (share.security?.maxViews) {
        this.logger.warn(
          `Stripped maxViews from reverse share upload: share=redacted`,
        );
      }
      share.recipients = [];
      if (share.security) {
        share.security = { password: share.security.password } as any;
      }
    }

    // The first free-form recipient entry can produce both a native change
    // event and a component selection event in some browsers. Never persist
    // duplicate addresses even if a client submits them deliberately.
    share.recipients = normalizeShareRecipients(share.recipients);

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
        `Team folder validated: share=redacted teamFolderId=${share.teamFolderId} teamId=${folder.teamId} userId=${user.id}`,
      );
      teamFolderConnect = { id: share.teamFolderId };
    }

    const storageProvider = this.configService.get("s3.enabled")
      ? "S3"
      : "LOCAL";
    this.logger.debug(
      `Selected storage provider: share=redacted provider=${storageProvider}`,
    );

    const {
      teamFolderId: _tfId,
      cryptoScheme: _requestedScheme,
      wrappedShareKey: _wrappedShareKey,
      wrappedShareKeyAlgorithm: _wrappedShareKeyAlgorithm,
      fileMetadataScheme: _fileMetadataScheme,
      ...shareData
    } = share;
    const cryptoData = this.resolveCreateCryptoData(
      share,
      user,
      !!reverseShare,
      !!teamFolderConnect,
    );

    const shareTuple = await this.prisma.$transaction(async (tx) => {
        fs.mkdirSync(`${SHARE_DIRECTORY}/${share.id}`, {
          recursive: true,
        });
        this.logger.debug(
          `Ensured share directory: share=redacted`,
        );

        const createdShare = await tx.share.create({
          data: {
            ...shareData,
            expiration: expirationDate,
            uploadLastActivityAt: new Date(),
            creator: { connect: user ? { id: user.id } : undefined },
            security: { create: share.security },
            recipients: {
              create: share.recipients
                ? share.recipients.map((email) => ({ email }))
                : [],
            },
            storageProvider,
            ...cryptoData,
            ...(teamFolderConnect && {
              teamFolder: { connect: teamFolderConnect },
            }),
          },
        });

        if (reverseShare) {
          await tx.reverseShare.update({
            where: { token: reverseShareToken },
            data: {
              shares: {
                connect: { id: createdShare.id },
              },
            },
          });
        }

        return createdShare;
    });

    this.logger.debug(
      `Share created: share=redacted userId=${user?.id ?? "anonymous"} recipients=${share.recipients?.length ?? 0} storage=${storageProvider} expires=${expirationDate.toISOString()}`,
    );
    if (cryptoData.cryptoScheme !== null) {
      this.logger.log(
        `Share crypto: share=redacted cryptoScheme=${shareCryptoSchemeName(cryptoData.cryptoScheme)}` +
          (cryptoData.fileMetadataScheme === FILE_META_V1
            ? " fileMetadataScheme=FILE_META_V1"
            : ""),
      );
    }

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
          .catch(() => this.logger.error("Failed to log UPLOAD"));
      }
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
          `Skipping file with unsafe archive path: share=redacted fileId=${file.id}`,
        );
        continue;
      }
      archive.append(fs.createReadStream(filePath), {
        name: archiveName,
      });
    }

    archive.pipe(writeStream);
    await archive.finalize();
    this.logger.debug("Created share archive");
  }

  async complete(id: string, reverseShareToken?: string, e2eKey?: string) {
    this.logger.debug(
      `Completing share: share=redacted reverseShareToken=${reverseShareToken ? "provided" : "none"} e2eKeyProvided=${!!e2eKey}`,
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
      this.logger.warn("Share not found during completion");
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
      this.logger.warn("Share is already completed");
      throw new BadRequestException("Share already completed");
    }
    await touchShareUploadActivity(this.prisma, share);

    if (share.files.length === 0) {
      this.logger.warn("Attempt to complete a share without files");
      throw new BadRequestException(
        "You need at least on file in your share to complete it.",
      );
    }

    // Claim completion before email, push and archive side effects. The
    // compare-and-set makes concurrent browser effects idempotent.
    const updatedShare = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.share.updateMany({
        where: { id, uploadLocked: false },
        data: { uploadLocked: true, hasBeenCompleted: true },
      });
      if (claimed.count !== 1) return null;

      if (
        share.reverseShare &&
        share.reverseShare.shareExpiration.getTime() !== 0
      ) {
        const decremented = await tx.reverseShare.updateMany({
          where: { token: reverseShareToken, remainingUses: { gt: 0 } },
          data: { remainingUses: { decrement: 1 } },
        });
        if (decremented.count === 0) {
          throw new ForbiddenException("Reverse share has no remaining uses");
        }
      }

      return tx.share.findUniqueOrThrow({ where: { id } });
    });

    if (!updatedShare) {
      this.logger.warn("Share was completed concurrently");
      throw new BadRequestException("Share already completed");
    }

    const shouldCreateZip =
      share.files.length > 1 || share.files.some((file) => !!file.relativePath);

    // Asynchronously create a zip of all files.
    // Skip ZIP for E2E encrypted shares (server can't read encrypted content).
    // A one-file folder upload still needs a ZIP to preserve its parent path.
    if (shouldCreateZip && !share.isE2EEncrypted) {
      this.logger.debug(
        `Scheduling zip creation: share=redacted fileCount=${share.files.length}`,
      );
      this.createZip(id)
        .then(async () => {
          await this.prisma.share.update({
            where: { id },
            data: { isZipReady: true },
          });
          this.logger.debug("Share archive is ready");
        })
        .catch(() => {
          this.logger.error("Zip creation failed");
        });
    }

    // Send email for each recipient
    const recipientEmails = normalizeShareRecipients(
      share.recipients.map((recipient) => recipient.email),
    );
    const recipientCount = recipientEmails.length;
    // Only include the E2E key in the email if the global admin setting allows it
    const e2eKeyForEmail =
      e2eKey && this.config.get("email.enableE2EKeyEmailSharing")
        ? e2eKey
        : undefined;
    if (recipientCount > 0 && this.config.get("smtp.enabled")) {
      this.logger.debug(
        `Sending recipient emails: share=redacted recipients=${recipientCount} e2eKeyInEmail=${!!e2eKeyForEmail}`,
      );
      for (const recipientEmail of recipientEmails) {
        try {
          await this.emailService.sendMailToShareRecipients(
            recipientEmail,
            share.id,
            share.creator,
            share.name,
            share.description,
            share.expiration,
            e2eKeyForEmail,
          );
          this.logger.debug("Recipient email sent");
        } catch {
          // Log and continue sending to others
          this.logger.error("Recipient email failed");
        }
      }
    } else {
      this.logger.debug(
        `Skipping recipient emails: share=redacted recipients=${recipientCount} smtpEnabled=${this.config.get("smtp.enabled")}`,
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
        this.logger.debug("Reverse-share creator notified");
      } catch {
        this.logger.error("Reverse share notification failed");
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
      this.logger.debug("Scheduling share malware scan");
      void this.clamScanService.checkAndRemove(share.id);
    } else {
      this.logger.debug("Skipping malware scan for E2E-encrypted share");
    }

    this.logger.debug(
      `Share completed: share=redacted files=${share.files.length} recipients=${recipientCount} uploadLocked=true`,
    );

    return completedShareResponse(updatedShare);
  }

  async revertComplete(id: string) {
    this.logger.debug("Reverting share completion");
    return this.prisma.share.update({
      where: { id },
      data: {
        uploadLocked: false,
        isZipReady: false,
        // Protect an actively edited share from inactivity cleanup.
        uploadLastActivityAt: new Date(),
      },
    });
  }

  async getAdminShares() {
    const shares = await this.prisma.share.findMany({
      orderBy: {
        expiration: "desc",
      },
      select: {
        adminAuditId: true,
        createdAt: true,
        expiration: true,
        uploadLocked: true,
        isE2EEncrypted: true,
        views: true,
        creator: { select: { username: true } },
        files: { select: { size: true } },
      },
    });

    return shares.map((share) => ({
      reference: share.adminAuditId,
      creator: share.creator,
      createdAt: share.createdAt,
      expiration: share.expiration,
      views: share.views,
      isE2EEncrypted: share.isE2EEncrypted,
      status: share.uploadLocked ? ("READY" as const) : ("UPLOADING" as const),
      fileCount: share.files.length,
      size: share.files.reduce((acc, file) => acc + parseInt(file.size), 0),
    }));
  }

  async removeByAdminReference(reference: string) {
    const share = await this.prisma.share.findUnique({
      where: { adminAuditId: reference },
      select: { id: true },
    });
    if (!share) throw new NotFoundException("Share not found");

    await this.remove(share.id, true);
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

  async setAnonymousSessionToken(shareId: string, tokenHash: string) {
    await this.prisma.share.update({
      where: { id: shareId },
      data: { anonymousSessionToken: tokenHash },
    });
  }

  async keepUploadAlive(shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: {
        id: true,
        uploadLocked: true,
        uploadLastActivityAt: true,
        uploadCleanupStartedAt: true,
      },
    });
    if (!share) throw new NotFoundException("Share not found");
    await touchShareUploadActivity(this.prisma, share);
  }

  verifyAnonymousSessionToken(
    share: { anonymousSessionToken?: string | null },
    rawToken: string,
  ): boolean {
    if (!share.anonymousSessionToken || !rawToken) return false;
    const actual = crypto.createHash("sha256").update(rawToken).digest();
    const expected = Buffer.from(share.anonymousSessionToken, "hex");
    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
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

  /**
   * SHARE_DEK_V1 key material of a personal share, with its owner for the
   * ownership check. The wrapped key is opaque to the server.
   */
  async getWrappedShareKey(shareId: string) {
    return this.prisma.share.findUnique({
      where: { id: shareId },
      select: {
        creatorId: true,
        cryptoScheme: true,
        wrappedShareKey: true,
        wrappedShareKeyAlgorithm: true,
        wrappedShareKeyVersion: true,
      },
    });
  }

  /**
   * Replace K_share wrapped under the previous K_master by the same K_share
   * wrapped under the new one. Compare-and-set on the version: a concurrent
   * rotation from another tab or device can never be silently overwritten.
   */
  async updateWrappedShareKey(
    shareId: string,
    userId: string,
    input: { wrappedShareKey: string; expectedVersion: number },
  ) {
    const { count } = await this.prisma.share.updateMany({
      where: {
        id: shareId,
        creatorId: userId,
        cryptoScheme: SHARE_DEK_V1,
        wrappedShareKeyVersion: input.expectedVersion,
      },
      data: {
        wrappedShareKey: input.wrappedShareKey,
        wrappedShareKeyVersion: { increment: 1 },
      },
    });

    if (count === 1) {
      this.logger.log(
        `Share key rewrapped: share=redacted cryptoScheme=SHARE_DEK_V1 version=${input.expectedVersion + 1}`,
      );
      return { wrappedShareKeyVersion: input.expectedVersion + 1 };
    }

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: { creatorId: true, cryptoScheme: true },
    });
    if (!share) throw new NotFoundException("Share not found");
    if (share.creatorId !== userId) {
      throw new ForbiddenException("Not the share owner");
    }
    if (share.cryptoScheme !== SHARE_DEK_V1) {
      throw new BadRequestException("Share does not use SHARE_DEK_V1");
    }
    throw new ConflictException(
      "The share key was rewrapped concurrently",
      "share_key_version_conflict",
    );
  }

  async remove(
    shareId: string,
    isDeleterAdmin = false,
    reverseShareToken?: string,
    anonymousSessionToken?: string,
  ) {
    this.logger.debug(
      `Removing share: share=redacted isDeleterAdmin=${isDeleterAdmin}`,
    );
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { reverseShare: { select: { token: true } } },
    });

    if (!share) {
      this.logger.warn("Share not found during removal");
      throw new NotFoundException("Share not found");
    }

    // Defense in depth for anonymous cancellations. ShareOwnerGuard performs
    // the first authorization check; the service independently verifies that
    // the supplied proof belongs to this exact share.
    if (!share.creatorId && !isDeleterAdmin) {
      const ownsViaReverseShare =
        !!reverseShareToken &&
        !!share.reverseShare?.token &&
        reverseShareToken === share.reverseShare.token;
      const ownsViaAnonymousSession =
        !!anonymousSessionToken &&
        this.verifyAnonymousSessionToken(share, anonymousSessionToken);

      if (!ownsViaReverseShare && !ownsViaAnonymousSession) {
        this.logger.warn(
          `Forbidden remove for anonymous share: share=redacted`,
        );
        throw new ForbiddenException("Anonymous share ownership not proven");
      }
    }

    // Delete files first; if it fails, abort DB deletion
    try {
      await this.fileService.deleteAllFiles(shareId);
      this.logger.debug("All share files deleted");
    } catch {
      this.logger.error("File deletion failed");
      throw new InternalServerErrorException(
        "Failed to delete all files of the share. Share has not been removed.",
      );
    }

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
          .catch(() => this.logger.error("Failed to log SHARE_DELETE"));
      }
    }

    this.logger.debug(
      `Share removed: share=redacted deletedBy=${share.creatorId ? "owner_or_user" : isDeleterAdmin ? "admin" : "unknown"}`,
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
      algorithm: "HS256",
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
        algorithms: ["HS256"],
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
