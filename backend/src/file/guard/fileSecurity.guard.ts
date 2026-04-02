import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import * as moment from "moment";
import { User } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";
import { ShareSecurityGuard } from "src/share/guard/shareSecurity.guard";
import { ShareService } from "src/share/share.service";
import { ConfigService } from "src/config/config.service";
import { JwtGuard } from "src/auth/guard/jwt.guard";

@Injectable()
export class FileSecurityGuard extends ShareSecurityGuard {
  constructor(
    private _shareService: ShareService,
    private _prisma: PrismaService,
    private _config: ConfigService,
  ) {
    super(_shareService, _prisma, _config);
  }

  /**
   * Soft-authenticate: run only JwtGuard (not ShareSecurityGuard) to
   * populate request.user without triggering token/password checks.
   */
  private async softAuthenticate(context: ExecutionContext): Promise<void> {
    try {
      await JwtGuard.prototype.canActivate.call(this, context);
    } catch {
      // User is not authenticated - request.user stays undefined
    }
  }

  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();

    const shareId = String(
      Object.prototype.hasOwnProperty.call(request.params, "shareId")
        ? request.params.shareId
        : request.params.id,
    );

    const shareToken = request.cookies[`share_${shareId}_token`];

    const share = await this._prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true, reverseShare: true },
    });

    // If there is no share token the user requests a file directly
    if (!shareToken) {
      if (
        !share ||
        (moment().isAfter(share.expiration) &&
          !moment(share.expiration).isSame(0))
      ) {
        throw new NotFoundException("File not found");
      }

      // If admin access is enabled and user is admin, allow access
      if (this._config.get("share.allowAdminAccessAllShares")) {
        await this.softAuthenticate(context);
        const user = request.user as User | undefined;
        if (user?.isAdmin) {
          await this._shareService.increaseViewCount(share);
          return true;
        }
      }

      if (share.security?.password)
        throw new ForbiddenException("This share is password protected");

      if (share.security?.maxViews && share.security.maxViews <= share.views) {
        throw new ForbiddenException(
          "Maximum views exceeded",
          "share_max_views_exceeded",
        );
      }

      // Reverse share access control: when publicAccess is false, only the
      // reverse-share creator and the share creator may download files.
      // When publicAccess is true the files are E2E-encrypted and useless
      // without K_rs (which lives in the URL fragment, never sent to server).
      if (share.reverseShare && !share.reverseShare.publicAccess) {
        await this.softAuthenticate(context);
        const user = request.user as User | undefined;
        const isOwner =
          (user && share.reverseShare.creatorId === user.id) ||
          (user && share.creatorId === user.id);
        if (!isOwner) {
          throw new ForbiddenException(
            "Only reverse share creator can access this share",
            "private_share",
          );
        }
      }

      await this._shareService.increaseViewCount(share);
      return true;
    } else {
      return super.canActivate(context);
    }
  }
}
