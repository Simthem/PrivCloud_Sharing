import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
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
@Controller("shares")
export class ShareController {
  constructor(
    private shareService: ShareService,
    private jwtService: JwtService,
    private config: ConfigService,
    private bridgeUploadTokenService: BridgeUploadTokenService,
  ) {}

  @Get("all")
  @UseGuards(JwtGuard, AdministratorGuard)
  async getAllShares() {
    return new AdminShareDTO().fromList(await this.shareService.getShares());
  }

  @Get()
  @UseGuards(JwtGuard)
  async getMyShares(@GetUser() user: User) {
    if (!user) throw new UnauthorizedException();
    return new MyShareDTO().fromList(
      await this.shareService.getSharesByUser(user.id),
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
   *  - 200 { encryptedReverseShareKey: null }   → not a reverse share (use K_master)
   *  - 200 { encryptedReverseShareKey: "..." }  → reverse share key (unwrap with K_master)
   *  - 403                                       → reverse share but user is not owner
   */
  @Get(":id/e2e-key")
  @UseGuards(JwtGuard)
  async getEncryptedE2eKey(
    @Param("id", SafeIdPipe) id: string,
    @GetUser() user: User,
  ) {
    const result = await this.shareService.getEncryptedReverseShareKey(id);

    // Not a reverse share or no encrypted key stored → client should use K_master
    if (!result) {
      return { encryptedReverseShareKey: null };
    }

    // Reverse share exists but user is not authenticated or not the owner → 403
    if (!user || result.creatorId !== user.id) {
      throw new ForbiddenException("Not the reverse share owner");
    }

    return { encryptedReverseShareKey: result.encryptedReverseShareKey };
  }

  @Post()
  @UseGuards(CreateShareGuard, AltchaGuard)
  async create(
    @Body() body: CreateShareDTO,
    @Req() request: Request,
    @GetUser() user: User,
  ) {
    const { reverse_share_token } = request.cookies;
    // Strip captchaToken - it was consumed by AltchaGuard and must not reach Prisma.
    const { captchaToken: _, ...shareData } = body;
    return new ShareDTO().from(
      await this.shareService.create(
        shareData as CreateShareDTO,
        user,
        reverse_share_token,
      ),
    );
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

  @Post(":id/bridge-upload-token")
  @Throttle({ default: { limit: 120, ttl: 3600 } })
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
  async remove(@Param("id", SafeIdPipe) id: string, @GetUser() user: User) {
    const isDeleterAdmin = user?.isAdmin === true;
    await this.shareService.remove(id, isDeleterAdmin);
  }

  @Throttle({
    default: {
      limit: 10,
      ttl: 60,
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
      ttl: 5 * 60,
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
        // Malformed cookie value — clear it immediately
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
          // Not a valid JWT payload — clear the cookie
          response.clearCookie(key);
          continue;
        }
        shareTokenCookies.push({ key, exp: (payload as any).exp });
      } catch {
        // jwtService.decode threw (not a JWT at all) — clear it
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
