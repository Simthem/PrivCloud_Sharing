import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import { isShareExpired } from "../share-expiration.util";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "src/config/config.service";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { User } from "@prisma/client";
import { TeamShareAccessService } from "../team-share-access.service";

@Injectable()
export class ShareTokenSecurity extends JwtGuard {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private teamShareAccessService: TeamShareAccessService,
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
      include: { security: true },
    });

    if (!share || isShareExpired(share.expiration))
      throw new NotFoundException("Share not found");

    if (share.teamFolderId) {
      try {
        await super.canActivate(context);
      } catch {
        await this.teamShareAccessService.assertCanAccessShare(
          shareId,
          undefined,
          {
            requireDownload: true,
          },
        );
      }

      await this.teamShareAccessService.assertCanAccessShare(
        shareId,
        request.user as User | undefined,
        {
          requireDownload: true,
        },
      );
    } else {
      // Optional here: a signed-in creator asking for a visit token of their
      // own share must not count as a visitor.
      try {
        await super.canActivate(context);
      } catch {
        // Anonymous visitor
      }
    }

    return true;
  }
}
