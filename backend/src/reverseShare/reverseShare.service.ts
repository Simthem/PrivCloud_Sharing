import { BadRequestException, Injectable } from "@nestjs/common";
import * as moment from "moment";
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

    const maxExpiration = this.config.get("share.maxExpiration");
    if (data.shareExpiration === "never") {
      if (maxExpiration.value !== 0) {
        throw new BadRequestException(
          "Never-expires is not allowed when a max expiration is configured",
        );
      }
    } else if (
      maxExpiration.value !== 0 &&
      expirationDate >
        moment().add(maxExpiration.value, maxExpiration.unit).toDate()
    ) {
      throw new BadRequestException(
        "Expiration date exceeds maximum expiration date",
      );
    }

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
      include: { shares: { include: { creator: true, security: true } } },
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
    const remainingUsesExceeded = reverseShare.remainingUses <= 0;

    return !(isExpired || remainingUsesExceeded);
  }

  async update(id: string, data: UpdateReverseShareDTO) {
    const expirationDate = parseRelativeDateToAbsolute(data.shareExpiration);

    const maxExpiration = this.config.get("share.maxExpiration");
    if (data.shareExpiration === "never") {
      if (maxExpiration.value !== 0) {
        throw new BadRequestException(
          "Never-expires is not allowed when a max expiration is configured",
        );
      }
    } else if (
      maxExpiration.value !== 0 &&
      expirationDate >
        moment().add(maxExpiration.value, maxExpiration.unit).toDate()
    ) {
      throw new BadRequestException(
        "Expiration date exceeds maximum expiration date",
      );
    }

    return this.prisma.reverseShare.update({
      where: { id },
      data: { shareExpiration: expirationDate },
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
