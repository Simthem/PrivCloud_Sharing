import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import moment from "moment";
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

    if (
      !share ||
      (moment().isAfter(share.expiration) &&
        !moment(share.expiration).isSame(0))
    )
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
    }

    return true;
  }
}
