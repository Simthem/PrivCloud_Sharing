import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { Request } from "express";
import * as crypto from "crypto";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import { anonymousShareSessionCookieName } from "src/share/anonymous-share-session.util";
import { JwtGuard } from "../../auth/guard/jwt.guard";

@Injectable()
export class ShareOwnerGuard extends JwtGuard {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private teamShareAccess: TeamShareAccessService,
  ) {
    super(configService);
  }

  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();
    const shareId = String(
      Object.prototype.hasOwnProperty.call(request.params, "shareId")
        ? request.params.shareId
        : request.params.id,
    );

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true, reverseShare: true },
    });

    if (!share) throw new NotFoundException("Share not found");

    // CreateShareGuard runs immediately before this guard on upload routes.
    // Reuse the principal it already resolved instead of executing the JWT
    // strategy and its user lookup a second time for every chunk.
    if (!request.user) {
      try {
        await super.canActivate(context);
      } catch {
        // passport strategy error - user stays null
      }
    }
    const user = request.user as User | undefined;

    // If it's an anonymous share, require the reverse_share_token cookie
    // to prove session ownership (prevents anyone from modifying anonymous shares)
    if (!share.creatorId) {
      if (share.reverseShare) {
        const { reverse_share_token } = request.cookies || {};
        if (
          reverse_share_token &&
          share.reverseShare.token === reverse_share_token
        ) {
          return true;
        }
      }
      // SECURITY: Anonymous shares without a valid reverse-share token require
      // a share-scoped session cookie whose SHA-256 hash matches the stored token.
      const anonymousSession =
        request.cookies?.[anonymousShareSessionCookieName(shareId)];
      if (anonymousSession && (share as any).anonymousSessionToken) {
        const actual = crypto
          .createHash("sha256")
          .update(anonymousSession)
          .digest();
        const expected = Buffer.from(
          (share as any).anonymousSessionToken,
          "hex",
        );
        if (
          actual.length === expected.length &&
          crypto.timingSafeEqual(actual, expected)
        ) {
          return true;
        }
      }
      // Deny - caller cannot prove ownership
      return false;
    }

    // If not signed in, deny access
    if (!user) return false;

    if (share.teamFolderId) {
      await this.teamShareAccess.assertCanManageShare(shareId, user);
      return true;
    }

    // If the user is the creator of the share, allow access
    if (share.creatorId == user.id) return true;

    // If the user is the creator of the parent reverse share, allow access
    if (share.reverseShare && share.reverseShare.creatorId === user.id)
      return true;

    return false;
  }
}
