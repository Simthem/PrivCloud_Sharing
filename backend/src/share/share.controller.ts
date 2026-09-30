import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { hours, minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { Request, Response } from "express";
import moment from "moment";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { BridgeUploadTokenService } from "src/bridgeUpload/bridge-upload-token.service";
import { AdminShareDTO } from "./dto/adminShare.dto";
import { CreateShareDTO } from "./dto/createShare.dto";
import { MyShareDTO } from "./dto/myShare.dto";
import { ShareDTO } from "./dto/share.dto";
import { ShareMetaDataDTO } from "./dto/shareMetaData.dto";
import { SharePasswordDto } from "./dto/sharePassword.dto";
import { CreateShareGuard } from "./guard/createShare.guard";
import { ShareOwnerGuard } from "./guard/shareOwner.guard";
import { ShareSecurityGuard } from "./guard/shareSecurity.guard";
import { ShareTokenSecurity } from "./guard/shareTokenSecurity.guard";
import { AltchaGuard } from "src/altcha/altcha.guard";
import { ShareService } from "./share.service";
import { CompletedShareDTO } from "./dto/shareComplete.dto";
import { ConfigService } from "../config/config.service";
import { SafeIdPipe } from "./pipe/safeId.pipe";
import {
  anonymousShareSessionCookieName,
  anonymousShareSessionCookiePath,
} from "./anonymous-share-session.util";
import { ShareCryptoEventDTO } from "./dto/shareCryptoEvent.dto";
import { UpdateWrappedShareKeyDTO } from "./dto/wrappedShareKey.dto";
import {
  SHARE_DEK_V1,
  isShareDekReadEnabled,
  shareCryptoCounters,
  shareCryptoSchemeName,
} from "./share-crypto-scheme";
@Controller("shares")
export class ShareController {
  private readonly logger = new Logger(ShareController.name);

  constructor(
    private shareService: ShareService,
    private jwtService: JwtService,
    private config: ConfigService,
    private bridgeUploadTokenService: BridgeUploadTokenService,
  ) {}

  @Get("all")
  @Header("Cache-Control", "private, no-store")
  @UseGuards(JwtGuard, AdministratorGuard)
  async getAllShares() {
    return new AdminShareDTO().fromList(
      await this.shareService.getAdminShares(),
    );
  }

  // Aggregated client crypto outcomes since the process started. Counters
  // only: no share, user or key information is ever recorded.
  @Get("crypto-metrics")
  @Header("Cache-Control", "private, no-store")
  @UseGuards(JwtGuard, AdministratorGuard)
  getCryptoMetrics() {
    return shareCryptoCounters.snapshot();
  }

  @Post("crypto-events")
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: hours(1) } })
  recordCryptoEvent(@Body() body: ShareCryptoEventDTO) {
    shareCryptoCounters.record(body);
    if (body.event !== "rewrap_ok") {
      this.logger.warn(
        `Client crypto event: event=${body.event} cryptoScheme=${body.scheme} client=${body.client} clientVersion=${body.clientVersion ?? "unknown"}`,
      );
    }
  }

  @Get()
  @UseGuards(JwtGuard)
  async getMyShares(@GetUser() user: User) {
    if (!user) throw new UnauthorizedException();
    const shares = await this.shareService.getSharesByUser(user.id);
    return new MyShareDTO().fromList(
      isShareDekReadEnabled()
        ? shares
        : shares.map((share) => ({
            ...share,
            wrappedShareKey: null,
            wrappedShareKeyAlgorithm: null,
            wrappedShareKeyVersion: null,
          })),
    );
  }

  @Get("recipients")
  @UseGuards(JwtGuard)
  async getStoredRecipients(@GetUser() user: User) {
    if (!user) return []; // fallback for unauthenticated users
    return await this.shareService.getStoredRecipientsByUser(user.id);
  }

  @Get(":id")
  @UseGuards(ShareSecurityGuard)
  async get(@Param("id", SafeIdPipe) id: string) {
    return new ShareDTO().from(await this.shareService.get(id));
  }

  @Get(":id/from-owner")
  @UseGuards(ShareOwnerGuard)
  async getFromOwner(@Param("id", SafeIdPipe) id: string) {
    return new ShareDTO().from(await this.shareService.getForOwner(id));
  }

  @Get(":id/metaData")
  @UseGuards(ShareSecurityGuard)
  async getMetaData(@Param("id", SafeIdPipe) id: string) {
    return new ShareMetaDataDTO().from(await this.shareService.getMetaData(id));
  }

  /**
   * Returns the encrypted reverse share key for E2E decryption.
   * Only the reverse share creator (owner) can access this.
   * The key is encrypted with K_master - the server never sees K_rs in clear.
   *
   * Returns:
   *  - 200 { encryptedReverseShareKey: null }   -> not a reverse share (use K_master)
   *  - 200 { encryptedReverseShareKey: "..." }  -> reverse share key (unwrap with K_master)
   *  - 403                                       -> reverse share but user is not owner
   */
  @Get(":id/e2e-key")
  @UseGuards(JwtGuard)
  async getEncryptedE2eKey(
    @Param("id", SafeIdPipe) id: string,
    @GetUser() user: User,
  ) {
    const result = await this.shareService.getEncryptedReverseShareKey(id);

    if (!result) {
      // SHARE_DEK_V1: K_share wrapped by K_master, for the owner only. Older
      // clients read encryptedReverseShareKey alone and keep their behaviour.
      const material = await this.shareService.getWrappedShareKey(id);
      if (!material || material.cryptoScheme !== SHARE_DEK_V1) {
        return { encryptedReverseShareKey: null, cryptoScheme: null };
      }
      if (!user || material.creatorId !== user.id) {
        throw new ForbiddenException("Not the share owner");
      }
      if (!isShareDekReadEnabled()) {
        return { encryptedReverseShareKey: null, cryptoScheme: SHARE_DEK_V1 };
      }
      this.logger.debug(
        `Wrapped share key served: share=redacted cryptoScheme=${shareCryptoSchemeName(material.cryptoScheme)}`,
      );
      return {
        encryptedReverseShareKey: null,
        cryptoScheme: SHARE_DEK_V1,
        wrappedShareKey: material.wrappedShareKey,
        wrappedShareKeyAlgorithm: material.wrappedShareKeyAlgorithm,
        wrappedShareKeyVersion: material.wrappedShareKeyVersion,
      };
    }

    // Reverse share exists but user is not authenticated or not the owner -> 403
    if (!user || result.creatorId !== user.id) {
      throw new ForbiddenException("Not the reverse share owner");
    }

    return { encryptedReverseShareKey: result.encryptedReverseShareKey };
  }

  /**
   * Store K_share rewrapped under a new K_master after a key rotation. The
   * encrypted files are not touched, so every recipient link stays valid.
   */
  @Patch(":id/wrapped-share-key")
  @Throttle({ default: { limit: 600, ttl: hours(1) } })
  @UseGuards(JwtGuard)
  async updateWrappedShareKey(
    @Param("id", SafeIdPipe) id: string,
    @GetUser() user: User,
    @Body() body: UpdateWrappedShareKeyDTO,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!isShareDekReadEnabled()) {
      throw new ForbiddenException("SHARE_DEK_V1 is disabled");
    }
    return this.shareService.updateWrappedShareKey(id, user.id, body);
  }

  @Post()
  @UseGuards(CreateShareGuard, AltchaGuard)
  async create(
    @Body() body: CreateShareDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @GetUser() user: User,
  ) {
    const { reverse_share_token } = request.cookies;
    // Strip captchaToken - it was consumed by AltchaGuard and must not reach Prisma.
    const { captchaToken: _, ...shareData } = body;
    const share = await this.shareService.create(
      shareData as CreateShareDTO,
      user,
      reverse_share_token,
    );
    if (share.cryptoScheme !== null && share.cryptoScheme !== undefined) {
      shareCryptoCounters.record({
        event: "share_created",
        scheme: shareCryptoSchemeName(share.cryptoScheme),
        client: "web",
      });
    }

    if (!share.creatorId) {
      const crypto = await import("crypto");
      const sessionToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto
        .createHash("sha256")
        .update(sessionToken)
        .digest("hex");
      await this.shareService.setAnonymousSessionToken(share.id, tokenHash);
      response.cookie(anonymousShareSessionCookieName(share.id), sessionToken, {
        path: anonymousShareSessionCookiePath(share.id),
        httpOnly: true,
        secure: this.config.get("general.secureCookies"),
        sameSite: "strict",
        maxAge: 24 * 60 * 60 * 1000,
      });
    }

    return new ShareDTO().from(share);
  }

  @Post(":id/complete")
  @HttpCode(202)
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async complete(
    @Param("id", SafeIdPipe) id: string,
    @Req() request: Request,
    @Body() body?: { e2eKey?: string },
  ) {
    const { reverse_share_token } = request.cookies;
    return new CompletedShareDTO().from(
      await this.shareService.complete(id, reverse_share_token, body?.e2eKey),
    );
  }

  @Post(":id/upload-heartbeat")
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: hours(1) } })
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async keepUploadAlive(@Param("id", SafeIdPipe) id: string) {
    await this.shareService.keepUploadAlive(id);
  }

  @Post(":id/bridge-upload-token")
  @Throttle({ default: { limit: 120, ttl: hours(1) } })
  @UseGuards(ShareOwnerGuard)
  async createBridgeUploadToken(
    @Param("id", SafeIdPipe) id: string,
    @GetUser() user: User,
    @Body() body?: { label?: string },
  ) {
    if (!user) throw new UnauthorizedException();
    return this.bridgeUploadTokenService.createToken(id, user.id, body?.label);
  }

  @Delete(":id/complete")
  @UseGuards(ShareOwnerGuard)
  async revertComplete(@Param("id", SafeIdPipe) id: string) {
    return new ShareDTO().from(await this.shareService.revertComplete(id));
  }

  @Delete(":id")
  @UseGuards(ShareOwnerGuard)
  async remove(
    @Param("id", SafeIdPipe) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const anonymousCookieName = anonymousShareSessionCookieName(id);
    await this.shareService.remove(
      id,
      false,
      request.cookies?.reverse_share_token,
      request.cookies?.[anonymousCookieName],
    );
    response.clearCookie(anonymousCookieName, {
      path: anonymousShareSessionCookiePath(id),
      secure: this.config.get("general.secureCookies"),
      sameSite: "strict",
    });
  }

  @Delete("admin/:reference")
  @HttpCode(204)
  @UseGuards(JwtGuard, AdministratorGuard)
  async removeFromAdminInventory(
    @Param("reference", SafeIdPipe) reference: string,
  ) {
    await this.shareService.removeByAdminReference(reference);
  }

  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(1),
    },
  })
  @Get("isShareIdAvailable/:id")
  async isShareIdAvailable(@Param("id", SafeIdPipe) id: string) {
    return this.shareService.isShareIdAvailable(id);
  }

  @HttpCode(200)
  @Throttle({
    default: {
      limit: 20,
      ttl: minutes(5),
    },
  })
  @UseGuards(ShareTokenSecurity, AltchaGuard)
  @Post(":id/token")
  async getShareToken(
    @Param("id", SafeIdPipe) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: SharePasswordDto,
  ) {
    const token = await this.shareService.getShareToken(id, body.password);

    this.clearShareTokenCookies(request, response);
    const isSecure = this.config.get("general.secureCookies");
    response.cookie(`share_${id}_token`, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: isSecure,
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
    });

    return { token };
  }

  /**
   * Keeps the 10 most recent share token cookies and deletes the rest and all expired ones
   */
  private clearShareTokenCookies(request: Request, response: Response) {
    const now = moment().unix();
    const shareTokenCookies: { key: string; exp: number }[] = [];

    for (const [key, value] of Object.entries(request.cookies)) {
      if (!key.startsWith("share_") || !key.endsWith("_token")) continue;
      if (typeof value !== "string" || !value) {
        // Malformed cookie value, clear it immediately
        response.clearCookie(key);
        continue;
      }
      try {
        const payload = this.jwtService.decode(value);
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as any).exp !== "number"
        ) {
          // Not a valid JWT payload, clear the cookie
          response.clearCookie(key);
          continue;
        }
        shareTokenCookies.push({ key, exp: (payload as any).exp });
      } catch {
        // jwtService.decode threw (not a JWT at all), clear it
        response.clearCookie(key);
      }
    }

    const expiredTokens = shareTokenCookies.filter((c) => c.exp < now);
    const validTokens = shareTokenCookies.filter((c) => c.exp >= now);

    expiredTokens.forEach((c) => response.clearCookie(c.key));

    if (validTokens.length > 10) {
      validTokens
        .sort((a, b) => a.exp - b.exp)
        .slice(0, -10)
        .forEach((c) => response.clearCookie(c.key));
    }
  }
}
