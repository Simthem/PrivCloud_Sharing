import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { ConfigService } from "src/config/config.service";
import { ReverseShareService } from "src/reverseShare/reverseShare.service";

@Injectable()
export class CreateShareGuard extends JwtGuard {
  constructor(
    configService: ConfigService,
    private reverseShareService: ReverseShareService,
  ) {
    super(configService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      if (await super.canActivate(context)) return true;
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
    }

    const request: Request = context.switchToHttp().getRequest();
    const reverseShareTokenId = request.cookies.reverse_share_token;

    if (!reverseShareTokenId) {
      // The browser removes expired access cookies. A refresh cookie can
      // still renew the account, so missing authentication must return 401.
      throw new UnauthorizedException();
    }

    const isReverseShareTokenValid =
      await this.reverseShareService.isValid(reverseShareTokenId);

    return isReverseShareTokenValid;
  }
}
