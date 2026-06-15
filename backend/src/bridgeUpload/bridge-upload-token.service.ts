import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "src/prisma/prisma.service";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class BridgeUploadTokenService {
  constructor(private prisma: PrismaService) {}

  async createToken(
    shareId: string,
    creatorId: string,
    label?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: { id: true, creatorId: true, uploadLocked: true },
    });

    if (!share) throw new NotFoundException("Share not found");
    if (share.uploadLocked)
      throw new BadRequestException("Share is already completed");
    if (!share.creatorId) {
      throw new ForbiddenException(
        "Bridge uploads require an authenticated share owner",
      );
    }
    if (share.creatorId !== creatorId) {
      throw new ForbiddenException(
        "You are not allowed to create a Bridge token for this share",
      );
    }

    await this.prisma.bridgeUploadToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    const token = `pcbu_${crypto.randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await this.prisma.bridgeUploadToken.create({
      data: {
        tokenHash: this.hashToken(token),
        expiresAt,
        label: label?.slice(0, 120),
        share: { connect: { id: shareId } },
        creator: { connect: { id: creatorId } },
      },
    });

    return { token, expiresAt };
  }

  async validateToken(shareId: string, token: string): Promise<void> {
    if (!token || !token.startsWith("pcbu_")) {
      throw new UnauthorizedException("Invalid Bridge upload token");
    }

    const record = await this.prisma.bridgeUploadToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { share: { select: { id: true, uploadLocked: true } } },
    });

    if (!record || record.shareId !== shareId) {
      throw new UnauthorizedException("Invalid Bridge upload token");
    }
    if (record.revokedAt) {
      throw new UnauthorizedException("Bridge upload token has been revoked");
    }
    if (record.expiresAt <= new Date()) {
      throw new UnauthorizedException("Bridge upload token has expired");
    }
    if (record.share.uploadLocked) {
      throw new BadRequestException("Share is already completed");
    }

    await this.prisma.bridgeUploadToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }
}
