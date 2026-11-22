import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ConfigService } from "src/config/config.service";

/**
 * Requires a signed-in user. Routes open to anonymous visitors handle the
 * missing user themselves, never through this guard.
 */
@Injectable()
export class JwtGuard extends AuthGuard("jwt") {
  constructor(protected config: ConfigService) {
    super();
  }

  handleRequest<TUser>(_err: unknown, user: TUser | false): TUser | null {
    return user || null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // The strategy failed: no token, or an invalid one.
    }
    if (!context.switchToHttp().getRequest().user) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
