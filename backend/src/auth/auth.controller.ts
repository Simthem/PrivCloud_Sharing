import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
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

import { UpdatePasswordDTO } from "./dto/updatePassword.dto";
import { VerifyTotpDTO } from "./dto/verifyTotp.dto";
import { HCaptchaGuard } from "./guard/hcaptcha.guard";
import { JwtGuard } from "./guard/jwt.guard";

@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private authTotpService: AuthTotpService,
    private config: ConfigService,
  ) {}

  @Post("signUp")
  @Throttle({
    default: {
      limit: 10,
      ttl: 5 * 60,
    },
  })
  @UseGuards(HCaptchaGuard)
  async signUp(
    @Body() dto: AuthRegisterDTO,
    @Req() { ip }: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!this.config.get("share.allowRegistration"))
      throw new ForbiddenException("Registration is not allowed");

    const result = await this.authService.signUp(dto, ip);

    this.authService.addTokensToResponse(
      response,
      result.refreshToken,
      result.accessToken,
    );

    // SECURITY: Only return user info; tokens are in HttpOnly cookies
    return { user: result.user };
  }

  @Post("signIn")
  @Throttle({
    default: {
      limit: 10,
      ttl: 5 * 60,
    },
  })
  async signIn(
    @Body() dto: AuthSignInDTO,
    @Req() { ip }: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.signIn(dto, ip);

    if (result.accessToken && result.refreshToken) {
      this.authService.addTokensToResponse(
        response,
        result.refreshToken,
        result.accessToken,
      );
    }

    // SECURITY: Only return loginToken (for TOTP flow) if present; tokens are in HttpOnly cookies
    if (result.loginToken) {
      return { loginToken: result.loginToken };
    }
    return {};
  }

  @Post("signIn/totp")
  @Throttle({
    default: {
      limit: 10,
      ttl: 5 * 60,
    },
  })
  @HttpCode(200)
  async signInTotp(
    @Body() dto: AuthSignInTotpDTO,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authTotpService.signInTotp(dto);

    this.authService.addTokensToResponse(
      response,
      result.refreshToken,
      result.accessToken,
    );

    // SECURITY: Tokens are in HttpOnly cookies; no need to expose in body
    return {};
  }

  @Post("resetPassword/request")
  @Throttle({
    default: {
      limit: 10,
      ttl: 5 * 60,
    },
  })
  @UseGuards(HCaptchaGuard)
  @HttpCode(202)
  async requestResetPassword(@Body("email") email: string) {
    // SECURITY: Email moved from URL param to body to avoid logging in access logs
    await this.authService.requestResetPassword(email);
  }

  @Post("resetPassword")
  @Throttle({
    default: {
      limit: 10,
      ttl: 5 * 60,
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

    this.authService.addTokensToResponse(response, result.refreshToken);
    // SECURITY: Tokens are set in HttpOnly cookies - do not leak in response body
    return {};
  }

  @Post("token")
  @HttpCode(200)
  async refreshAccessToken(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!request.cookies.refresh_token) throw new UnauthorizedException();

    const result = await this.authService.refreshAccessToken(
      request.cookies.refresh_token,
    );
    this.authService.addTokensToResponse(
      response,
      result.refreshToken,
      result.accessToken,
    );
    // SECURITY: Tokens are set in HttpOnly cookies - do not leak in response body
    return {};
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
    // httpOnly: false - intentional. This is a non-sensitive session indicator (value: "")
    // readable by JS to detect logout without exposing tokens.
    response.cookie("logged_in", "", {
      path: "/",
      httpOnly: false,
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
