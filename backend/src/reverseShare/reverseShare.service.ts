import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "src/config/config.service";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import { parseRelativeDateToAbsolute } from "src/utils/date.util";
import { CreateReverseShareDTO } from "./dto/createReverseShare.dto";
import { UpdateReverseShareDTO } from "./dto/updateReverseShare.dto";

@Injectable()
export class ReverseShareService {
  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private fileService: FileService,
  ) {}

  async create(data: CreateReverseShareDTO, creatorId: string) {
    const expirationDate = parseRelativeDateToAbsolute(data.shareExpiration);

    // Reverse share link expiration is independent from individual share
    // expiration (share.maxExpiration).  The link expiration controls how
    // long the upload URL stays valid; the share expiration controls how
    // long uploaded files remain accessible.  A "personal" RS link can
    // be set to never expire regardless of the share max-expiration config.

    const globalMaxShareSize = this.config.get("share.maxSize");

    if (globalMaxShareSize < data.maxShareSize)
      throw new BadRequestException(
        `Max share size can't be greater than ${globalMaxShareSize} bytes.`,
      );

    const reverseShare = await this.prisma.reverseShare.create({
      data: {
        name: data.name,
        shareExpiration: expirationDate,
        remainingUses: data.maxUseCount,
        maxShareSize: data.maxShareSize,
        sendEmailNotification: data.sendEmailNotification,
        simplified: data.simplified,
        publicAccess: data.publicAccess,
        encryptedReverseShareKey: data.encryptedReverseShareKey || null,
        creatorId,
      },
    });

    return reverseShare.token;
  }

  async getByToken(reverseShareToken?: string) {
    if (!reverseShareToken) return null;

    const reverseShare = await this.prisma.reverseShare.findUnique({
      where: { token: reverseShareToken },
    });

    return reverseShare;
  }

  async getAllByUser(userId: string) {
    const reverseShares = await this.prisma.reverseShare.findMany({
      where: {
        creatorId: userId,
        OR: [
          { shareExpiration: { gt: new Date() } },
          { shareExpiration: new Date(0) },
        ],
      },
      orderBy: {
        shareExpiration: "desc",
      },
      include: {
        shares: {
          where: { uploadLocked: true },
          include: { creator: true, security: true },
        },
      },
    });

    return reverseShares.map((reverseShare) => ({
      ...reverseShare,
      shares: reverseShare.shares.map((share) => ({
        ...share,
        security: {
          maxViews: share.security?.maxViews,
          passwordProtected: !!share.security?.password,
        },
      })),
    }));
  }

  async isValid(reverseShareToken: string) {
    const reverseShare = await this.prisma.reverseShare.findUnique({
      where: { token: reverseShareToken },
    });

    if (!reverseShare) return false;

    const neverExpires = reverseShare.shareExpiration.getTime() === 0;
    const isExpired = !neverExpires && new Date() > reverseShare.shareExpiration;
    // Personal links (never-expiring) have unlimited uses
    const remainingUsesExceeded =
      !neverExpires && reverseShare.remainingUses <= 0;

    return !(isExpired || remainingUsesExceeded);
  }

  async update(id: string, data: UpdateReverseShareDTO) {
    const existing = await this.prisma.reverseShare.findUnique({
      where: { id },
    });

    if (!existing) throw new BadRequestException("Reverse share not found");

    const updateData: Record<string, any> = {};

    if (data.shareExpiration !== undefined) {
      // Personal links (never-expiring) must not have their expiration changed.
      if (existing.shareExpiration.getTime() === 0) {
        throw new BadRequestException(
          "Cannot modify expiration of a permanent personal link",
        );
      }
      updateData.shareExpiration = parseRelativeDateToAbsolute(
        data.shareExpiration,
      );
    }

    if (data.encryptedReverseShareKey !== undefined) {
      updateData.encryptedReverseShareKey = data.encryptedReverseShareKey;
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException("No fields to update");
    }

    // RS link expiration is independent from share.maxExpiration (see create()).

    return this.prisma.reverseShare.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: string) {
    const shares = await this.prisma.share.findMany({
      where: { reverseShare: { id } },
    });

    for (const share of shares) {
      await this.prisma.share.delete({ where: { id: share.id } });
      await this.fileService.deleteAllFiles(share.id);
    }

    await this.prisma.reverseShare.delete({ where: { id } });
  }
}
