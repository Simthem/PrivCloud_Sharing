import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import * as moment from "moment";
import { PrismaService } from "src/prisma/prisma.service";
import { ShareService } from "src/share/share.service";
import { ConfigService } from "src/config/config.service";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { User } from "@prisma/client";

@Injectable()
export class ShareSecurityGuard extends JwtGuard {
  constructor(
    private shareService: ShareService,
    private prisma: PrismaService,
    private configService: ConfigService,
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

    const shareToken = request.cookies[`share_${shareId}_token`];

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true, reverseShare: true },
    });

    if (!share) throw new NotFoundException("Share not found");

    // Run the JWTGuard to set the user
    await super.canActivate(context);
    const user = request.user as User;

    if (
      moment().isAfter(share.expiration) &&
      !moment(share.expiration).isSame(0)
    ) {
      throw new NotFoundException("Share not found");
    }

    // The reverse share creator (the account that generated the RS link)
    // can always access any share uploaded via their RS link - they own
    // the data and should not be blocked by passwords or tokens set by
    // the uploader.
    const isRsCreator =
      share.reverseShare && user && share.reverseShare.creatorId === user.id;

    // The share creator also bypasses password/token checks (they set them).
    const isShareCreator = user && share.creatorId === user.id;

    if (isRsCreator || isShareCreator) {
      return true;
    }

    // Password & token checks - enforced for all other visitors.
    if (share.security?.password && !shareToken)
      throw new ForbiddenException(
        "This share is password protected",
        "share_password_required",
      );

    if (!(await this.shareService.verifyShareToken(shareId, shareToken)))
      throw new ForbiddenException(
        "Share token required",
        "share_token_required",
      );

    // Admin bypass: allows access to all shares but does NOT skip
    // password/token protection (handled above).
    if (
      user?.isAdmin &&
      this.configService.get("share.allowAdminAccessAllShares")
    ) {
      return true;
    }

    // Restrict access to reverse share results.
    // When publicAccess=false only the share creator and the RS creator
    // can view the share.  When publicAccess=true anyone with the link
    // may access it -- even if E2E is enabled, because the files are
    // encrypted and useless without K_rs (which lives in the URL
    // fragment and is never sent to the server).
    if (share.reverseShare) {
      const isPrivate = !share.reverseShare.publicAccess;
      const isOwnerOrCreator =
        share.creatorId === user?.id ||
        share.reverseShare.creatorId === user?.id;

      if (isPrivate && !isOwnerOrCreator) {
        throw new ForbiddenException(
          "Only reverse share creator can access this share",
          "private_share",
        );
      }
    }

    return true;
  }
}
