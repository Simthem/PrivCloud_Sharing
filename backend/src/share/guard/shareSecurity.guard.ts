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

    // Password & token checks — always enforced, even for admins.
    // The password protects the share content, not just access control.
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
    // - publicAccess=false → only the share creator and RS creator can access.
    // - E2E encrypted reverse share → always restrict to owner/creator
    //   regardless of publicAccess.  E2E files are useless without K_rs and
    //   exposing ciphertext + metadata publicly is a security risk.
    if (share.reverseShare) {
      const isE2E = !!share.reverseShare.encryptedReverseShareKey;
      const isPrivate = !share.reverseShare.publicAccess;
      const isOwnerOrCreator =
        share.creatorId === user?.id ||
        share.reverseShare.creatorId === user?.id;

      if ((isPrivate || isE2E) && !isOwnerOrCreator) {
        throw new ForbiddenException(
          "Only reverse share creator can access this share",
          "private_share",
        );
      }
    }

    return true;
  }
}
