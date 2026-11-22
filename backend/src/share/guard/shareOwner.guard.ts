import {
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { Request } from "express";
import * as crypto from "crypto";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import { anonymousShareSessionCookieName } from "src/share/anonymous-share-session.util";
import { JwtGuard } from "../../auth/guard/jwt.guard";
import { isShareExpired } from "../share-expiration.util";

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
      } catch (error) {
        if (!(error instanceof UnauthorizedException)) throw error;
      }
    }
    const user = request.user as User | undefined;

    // An anonymous share belongs to the browser session that created it. The
    // link of a reverse share is shared by every uploader, so it proves
    // nothing, and an upload through it stops being the uploader's once it is
    // finished or the link has expired.
    if (!share.creatorId) {
      if (
        share.reverseShare &&
        (share.uploadLocked ||
          isShareExpired(share.reverseShare.shareExpiration))
      ) {
        return false;
      }
      const anonymousSession =
        request.cookies?.[anonymousShareSessionCookieName(shareId)];
      if (anonymousSession && share.anonymousSessionToken) {
        const actual = crypto
          .createHash("sha256")
          .update(anonymousSession)
          .digest();
        const expected = Buffer.from(share.anonymousSessionToken, "hex");
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
    if (!user) throw new UnauthorizedException();

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
