import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { Strategy } from "passport-jwt";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { assertEmailVerificationAccess } from "src/emailVerification/emailVerification.util";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    config.get("internal.jwtSecret");
    super({
      jwtFromRequest: JwtStrategy.extractJWT,
      secretOrKey: config.get("internal.jwtSecret"),
      algorithms: ["HS256"],
    });
  }

  private static extractJWT(req: Request) {
    return req.cookies?.access_token || null;
  }

  async validate(payload: { sub?: string; refreshTokenId?: string }) {
    if (!payload.sub || !payload.refreshTokenId) {
      throw new UnauthorizedException();
    }

    // Validate the JWT and its backing session in one indexed lookup. Deleting
    // a refresh-token row on sign-out
    // or password reset therefore revokes the associated access token too.
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        refreshTokens: {
          some: {
            id: payload.refreshTokenId,
            expiresAt: { gt: new Date() },
          },
        },
      },
    });
    if (!user) throw new UnauthorizedException();
    assertEmailVerificationAccess(user);
    return user;
  }
}
