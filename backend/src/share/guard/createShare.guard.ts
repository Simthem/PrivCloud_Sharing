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
    if (await super.canActivate(context)) return true;

    const request: Request = context.switchToHttp().getRequest();
    const reverseShareTokenId = request.cookies.reverse_share_token;

    if (!reverseShareTokenId) {
      // JwtGuard returned false (token absent or expired) and there
      // is no reverse share fallback.  If an access_token cookie was
      // present the token likely just expired -- throw 401 so the
      // client can refresh it instead of receiving a generic 403.
      if (request.cookies?.access_token) {
        throw new UnauthorizedException();
      }
      return false;
    }

    const isReverseShareTokenValid =
      await this.reverseShareService.isValid(reverseShareTokenId);

    return isReverseShareTokenValid;
  }
}
