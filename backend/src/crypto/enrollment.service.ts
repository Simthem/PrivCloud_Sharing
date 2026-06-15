import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { CreateEnrollmentTokenDTO, ConsumeEnrollmentTokenDTO } from "./dto/crypto.dto";

@Injectable()
export class EnrollmentTokenService {
  private readonly logger = new Logger(EnrollmentTokenService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Create an enrollment token for onboarding, team join, or device addition.
   *
   * These tokens are ONE-TIME USE and do NOT carry any file keys.
   * Their purpose is ONLY to:
   * - Register a new device's identity key
   * - Associate a user with a team
   * - Bootstrap the vault on a new device
   */
  async createToken(creatorId: string, dto: CreateEnrollmentTokenDTO) {
    // Validate team access if purpose is TEAM_JOIN
    if (dto.purpose === "TEAM_JOIN") {
      if (!dto.teamId) {
        throw new BadRequestException("teamId is required for TEAM_JOIN tokens");
      }

      // Creator must be team owner/admin
      const membership = await this.prisma.teamMember.findFirst({
        where: {
          userId: creatorId,
          teamId: dto.teamId,
          isActive: true,
          role: { in: ["OWNER", "ADMIN"] },
        },
      });

      if (!membership) {
        throw new ForbiddenException(
          "Only team owner/admin can create TEAM_JOIN enrollment tokens",
        );
      }
    }

    // Generate high-entropy URL-safe token (32 bytes = 256 bits)
    const token = randomBytes(32).toString("base64url");

    // Default expiry: 48 hours
    const expiresInMs = (dto.expiresInHours || 48) * 60 * 60 * 1000;
    // Cap at 7 days maximum
    const maxExpiryMs = 7 * 24 * 60 * 60 * 1000;
    const actualExpiryMs = Math.min(expiresInMs, maxExpiryMs);

    const enrollmentToken = await this.prisma.enrollmentToken.create({
      data: {
        token,
        purpose: dto.purpose,
        metadata: dto.metadata,
        creatorId,
        teamId: dto.teamId,
        expiresAt: new Date(Date.now() + actualExpiryMs),
        status: "PENDING",
      },
    });

    this.logger.log(
      `Enrollment token created: ${dto.purpose} by ${creatorId}` +
        (dto.teamId ? ` for team ${dto.teamId}` : ""),
    );

    return {
      id: enrollmentToken.id,
      token: enrollmentToken.token,
      purpose: enrollmentToken.purpose,
      expiresAt: enrollmentToken.expiresAt,
    };
  }

  /**
   * Consume an enrollment token. This is a one-time operation:
   * - Validates the token
   * - Marks it as used
   * - Returns the metadata (team ID, role, etc.) for the client to proceed
   *
   * After consumption, the client should:
   * 1. Register identity keys (if not already)
   * 2. Join the team (if TEAM_JOIN)
   * 3. Initialize local vault (if DEVICE_ADD)
   */
  async consumeToken(userId: string, dto: ConsumeEnrollmentTokenDTO) {
    // SECURITY: Atomic conditional update prevents race condition where two
    // concurrent requests both read PENDING then both mark as USED.
    const result = await this.prisma.enrollmentToken.updateMany({
      where: {
        token: dto.token,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      data: {
        status: "USED",
        usedAt: new Date(),
        usedById: userId,
      },
    });

    if (result.count === 0) {
      // Determine the reason for failure
      const enrollment = await this.prisma.enrollmentToken.findUnique({
        where: { token: dto.token },
      });

      if (!enrollment) {
        throw new NotFoundException("Invalid enrollment token");
      }
      if (enrollment.expiresAt < new Date()) {
        // Mark as expired for cleanup
        await this.prisma.enrollmentToken.updateMany({
          where: { id: enrollment.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
        throw new BadRequestException("Token has expired");
      }
      throw new BadRequestException(
        `Token already ${enrollment.status.toLowerCase()}`,
      );
    }

    // Re-fetch with full data for the post-consumption logic
    const enrollment = await this.prisma.enrollmentToken.findUnique({
      where: { token: dto.token },
    });

    this.logger.log(
      `Enrollment token consumed: ${enrollment.purpose} by user ${userId}`,
    );

    return {
      purpose: enrollment.purpose,
      teamId: enrollment.teamId,
      metadata: (() => {
        if (!enrollment.metadata) return null;
        try {
          return JSON.parse(enrollment.metadata);
        } catch {
          return null;
        }
      })(),
    };
  }

  /**
   * Revoke an enrollment token (before it's used).
   */
  async revokeToken(tokenId: string, revokerId: string) {
    const enrollment = await this.prisma.enrollmentToken.findUnique({
      where: { id: tokenId },
    });

    if (!enrollment) throw new NotFoundException("Token not found");
    if (enrollment.creatorId !== revokerId) {
      throw new ForbiddenException("Only the token creator can revoke it");
    }
    if (enrollment.status !== "PENDING") {
      throw new BadRequestException("Can only revoke pending tokens");
    }

    await this.prisma.enrollmentToken.update({
      where: { id: tokenId },
      data: { status: "REVOKED" },
    });

    return { id: tokenId, status: "REVOKED" };
  }

  /**
   * List active enrollment tokens created by a user.
   */
  async listMyTokens(creatorId: string) {
    const tokens = await this.prisma.enrollmentToken.findMany({
      where: { creatorId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        purpose: true,
        status: true,
        teamId: true,
        expiresAt: true,
        createdAt: true,
        usedAt: true,
        usedById: true,
      },
    });

    return tokens;
  }

  /**
   * Cleanup expired tokens (called by cron job).
   */
  async cleanupExpiredTokens() {
    const result = await this.prisma.enrollmentToken.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: new Date() },
      },
      data: { status: "EXPIRED" },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired enrollment tokens`);
    }

    return result.count;
  }
}
