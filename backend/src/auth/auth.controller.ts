import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { Request, Response } from "express";
import { ConfigService } from "src/config/config.service";
import { AuthService } from "./auth.service";
import { AuthTotpService } from "./authTotp.service";
import { GetUser } from "./decorator/getUser.decorator";
import { AuthRegisterDTO } from "./dto/authRegister.dto";
import { AuthSignInDTO } from "./dto/authSignIn.dto";
import { AuthSignInTotpDTO } from "./dto/authSignInTotp.dto";
import { EnableTotpDTO } from "./dto/enableTotp.dto";
import { ResetPasswordDTO } from "./dto/resetPassword.dto";
import { ResetPasswordRequestDTO } from "./dto/resetPasswordRequest.dto";

import { UpdatePasswordDTO } from "./dto/updatePassword.dto";
import { VerifyTotpDTO } from "./dto/verifyTotp.dto";
import { AltchaGuard } from "src/altcha/altcha.guard";
import { JwtGuard } from "./guard/jwt.guard";

@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private authTotpService: AuthTotpService,
    private config: ConfigService,
  ) {}

  private issueTokens(
    response: Response,
    refreshToken?: string,
    accessToken?: string,
  ): Record<string, never> {
    this.authService.addTokensToResponse(response, refreshToken, accessToken);
    // The public web client receives session tokens only as HttpOnly cookies.
    return {};
  }

  @Post("signUp")
  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(5),
    },
  })
  @UseGuards(AltchaGuard)
  async signUp(
    @Body() dto: AuthRegisterDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!this.config.get("share.allowRegistration"))
      throw new ForbiddenException("Registration is not allowed");

    const result = await this.authService.signUp(dto, request.ip);

    return {
      user: result.user,
      ...this.issueTokens(response, result.refreshToken, result.accessToken),
    };
  }

  @Post("signIn")
  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(5),
    },
  })
  @UseGuards(AltchaGuard)
  async signIn(
    @Body() dto: AuthSignInDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.signIn(dto, request.ip);

    // TOTP flow: no session yet, only a short-lived login token. Nothing to
    // issue on either channel until the second factor is verified.
    if (result.loginToken) {
      return { loginToken: result.loginToken };
    }

    if (!result.accessToken || !result.refreshToken) return {};

    return this.issueTokens(response, result.refreshToken, result.accessToken);
  }

  @Post("signIn/totp")
  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(5),
    },
  })
  @HttpCode(200)
  async signInTotp(
    @Body() dto: AuthSignInTotpDTO,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authTotpService.signInTotp(dto);

    return this.issueTokens(response, result.refreshToken, result.accessToken);
  }

  @Post("resetPassword/request")
  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(5),
    },
  })
  @UseGuards(AltchaGuard)
  @HttpCode(202)
  async requestResetPassword(@Body() dto: ResetPasswordRequestDTO) {
    // SECURITY: Email moved from URL param to body to avoid logging in access logs
    await this.authService.requestResetPassword(dto.email);
  }

  @Post("resetPassword")
  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(5),
    },
  })
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDTO) {
    return await this.authService.resetPassword(dto.token, dto.password);
  }

  @Patch("password")
  @UseGuards(JwtGuard)
  async updatePassword(
    @GetUser() user: User,
    @Res({ passthrough: true }) response: Response,
    @Body() dto: UpdatePasswordDTO,
  ) {
    const result = await this.authService.updatePassword(
      user,
      dto.password,
      dto.oldPassword,
    );

    // The password change revoked every previous refresh token; hand the
    // freshly issued one back so the client keeps its session.
    return this.issueTokens(response, result.refreshToken);
  }

  @Post("token")
  @HttpCode(200)
  async refreshAccessToken(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = request.cookies.refresh_token;
    if (!refreshToken) throw new UnauthorizedException();

    const result = await this.authService.refreshAccessToken(refreshToken);

    return this.issueTokens(response, result.refreshToken, result.accessToken);
  }

  @Get("session")
  @HttpCode(200)
  sessionState(@Req() request: Request) {
    return { active: !!request.cookies.logged_in };
  }

  @Post("signOut")
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const redirectURI = await this.authService.signOut(
      request.cookies.access_token,
    );

    const isSecure = this.config.get("general.secureCookies");
    response.cookie("access_token", "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: -1,
      secure: isSecure,
    });
    response.cookie("refresh_token", "", {
      path: "/api/auth/token",
      httpOnly: true,
      sameSite: "lax",
      maxAge: -1,
      secure: isSecure,
    });
    response.cookie("logged_in", "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: -1,
      secure: isSecure,
    });

    // Clean up any leftover OAuth state cookies
    for (const name of Object.keys(request.cookies)) {
      if (name.startsWith("oauth_") && name.endsWith("_state")) {
        response.clearCookie(name, {
          sameSite: "lax",
          secure: isSecure,
          httpOnly: true,
        });
      }
    }

    if (typeof redirectURI === "string") {
      return { redirectURI: redirectURI.toString() };
    }
  }

  @Post("totp/enable")
  @UseGuards(JwtGuard)
  async enableTotp(@GetUser() user: User, @Body() body: EnableTotpDTO) {
    return this.authTotpService.enableTotp(user, body.password);
  }

  @Post("totp/verify")
  @UseGuards(JwtGuard)
  async verifyTotp(@GetUser() user: User, @Body() body: VerifyTotpDTO) {
    return this.authTotpService.verifyTotp(user, body.password, body.code);
  }

  @Post("totp/disable")
  @UseGuards(JwtGuard)
  async disableTotp(@GetUser() user: User, @Body() body: VerifyTotpDTO) {
    // Note: We use VerifyTotpDTO here because it has both fields we need: password and totp code
    return this.authTotpService.disableTotp(user, body.password, body.code);
  }
}
