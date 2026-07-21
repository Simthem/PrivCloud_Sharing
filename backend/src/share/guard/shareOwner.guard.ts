import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { Request } from "express";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamShareAccessService } from "src/share/team-share-access.service";
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

    // Run the JWTGuard to set the user
    await super.canActivate(context);
    const user = request.user as User;

    const allowPlatformAdmin = this.configService.get(
      "share.allowAdminAccessAllShares",
    );

    // If the user is an admin, allow access only when the global share
    // inspection setting is enabled.
    if (user?.isAdmin && allowPlatformAdmin) return true;

    // If it's a anonymous share, allow access
    if (!share.creatorId) return true;

    // If not signed in, deny access
    if (!user) return false;

    if (share.teamFolderId) {
      await this.teamShareAccess.assertCanManageShare(shareId, user, {
        allowPlatformAdmin,
      });
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
