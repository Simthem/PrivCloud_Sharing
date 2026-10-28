import { AuthenticatedUserGuard } from "./guard/authenticatedUser.guard";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
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

import {
  OAUTH_REAUTH_COOKIE,
  OAUTH_REAUTH_COOKIE_PATH,
} from "./oauthReauth.service";
import { EmailService } from "src/email/email.service";
import { PasskeyStepUpDTO } from "./dto/passkeyStepUp.dto";
import { AccountPasskeyService } from "src/passkey/accountPasskey.service";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";
import { EmailChangeService } from "./emailChange.service";
import { EmailChangeDTO, EmailChangeTokenDTO } from "./dto/emailChange.dto";
import { StepUpDTO, StepUpScopeDTO } from "./dto/stepUp.dto";
import {
  STEP_UP_COOKIE,
  STEP_UP_COOKIE_PATH,
  STEP_UP_TTL_MS,
  StepUpMethod,
  StepUpService,
} from "./stepUp.service";
import { PrismaService } from "src/prisma/prisma.service";

@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private authTotpService: AuthTotpService,
    private config: ConfigService,
    private passkeys: AccountPasskeyService,
    private emailService: EmailService,
    private emailChanges: EmailChangeService,
    private stepUp: StepUpService,
    private prisma: PrismaService,
  ) {}

  @Post("email-change")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  requestEmailChange(
    @GetUser() user: User,
    @Body() body: EmailChangeDTO,
    @Req() request: Request,
  ) {
    return this.emailChanges.initiate(
      user.id,
      body,
      request.cookies?.[OAUTH_REAUTH_COOKIE],
    );
  }

  @Post("email-change/confirm")
  @Throttle({ default: { limit: 10, ttl: minutes(5) } })
  confirmEmailChange(@Body() body: EmailChangeTokenDTO) {
    return this.emailChanges.confirm(body.token);
  }

  @Post("email-change/cancel")
  @Throttle({ default: { limit: 10, ttl: minutes(5) } })
  cancelEmailChange(@Body() body: EmailChangeTokenDTO) {
    return this.emailChanges.cancel(body.token);
  }

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

  /** WebAuthn options for a sign-in without an address. */
  @Post("passkey/options")
  @Throttle({ default: { limit: 20, ttl: minutes(5) } })
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  passkeyOptions() {
    return this.passkeys.beginLogin();
  }

  @Post("passkey")
  @Throttle({
    default: {
      limit: 10,
      ttl: minutes(5),
    },
  })
  @HttpCode(200)
  async signInWithPasskey(
    @Body() dto: PasskeyResponseDTO,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.passkeys.verifyLogin(dto);
    const result = await this.authService.signInWithPasskey(user);
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
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() dto: UpdatePasswordDTO,
  ) {
    await this.authService.updatePassword(
      user,
      dto.password,
      dto.oldPassword,
      request.cookies?.[OAUTH_REAUTH_COOKIE],
    );
    this.clearReauthProof(response);

    // The password change revoked every previous refresh token; hand the
    // freshly issued one back so the client keeps its session.
    const { refreshToken } = await this.authService.createRefreshToken(user.id);
    return this.issueTokens(response, refreshToken);
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
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  async enableTotp(
    @GetUser() user: User,
    @Body() body: EnableTotpDTO,
    @Req() request: Request,
  ) {
    return this.authTotpService.enableTotp(user, {
      password: body.password,
      reauthProof: request.cookies?.[OAUTH_REAUTH_COOKIE],
    });
  }

  @Post("totp/verify")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  async verifyTotp(
    @GetUser() user: User,
    @Body() body: VerifyTotpDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authTotpService.verifyTotp(
      user,
      {
        password: body.password,
        reauthProof: request.cookies?.[OAUTH_REAUTH_COOKIE],
      },
      body.code,
    );
    this.clearReauthProof(response);
    return result;
  }

  @Post("totp/disable")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  async disableTotp(
    @GetUser() user: User,
    @Body() body: VerifyTotpDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Note: We use VerifyTotpDTO here because it has both fields we need: password and totp code
    const result = await this.authTotpService.disableTotp(
      user,
      {
        password: body.password,
        reauthProof: request.cookies?.[OAUTH_REAUTH_COOKIE],
      },
      body.code,
    );
    this.clearReauthProof(response);
    return result;
  }

  /**
   * Adding a passkey lets its holder sign in without password nor 2FA code:
   * it takes the same proof as turning 2FA off, so a stolen session alone
   * cannot plant one.
   */
  @Post("passkey/registration")
  @UseGuards(AuthenticatedUserGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async beginPasskeyRegistration(
    @GetUser() user: User,
    @Body() body: PasskeyStepUpDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authTotpService.confirmSecondFactorChange(
      user,
      {
        password: body.password,
        reauthProof: request.cookies?.[OAUTH_REAUTH_COOKIE],
      },
      body.code,
    );
    this.clearReauthProof(response);
    return this.passkeys.beginRegistration(user);
  }

  @Post("passkey/registration/verify")
  @UseGuards(AuthenticatedUserGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  @HttpCode(200)
  async finishPasskeyRegistration(
    @GetUser() user: User,
    @Body() dto: PasskeyResponseDTO,
  ) {
    const passkey = await this.passkeys.finishRegistration(user, dto);
    // The owner hears of it even when someone else did it.
    if (this.config.get("smtp.enabled")) {
      await this.emailService
        .sendPasskeyAddedEmail(user.email)
        .catch(() => undefined);
    }
    return passkey;
  }

  /** The ways this user can confirm a sensitive operation. */
  @Get("step-up")
  @UseGuards(JwtGuard)
  @Header("Cache-Control", "private, no-store")
  async stepUpMethods(@GetUser() user: User) {
    const [providers, passkey] = await Promise.all([
      this.prisma.oAuthUser.findMany({
        where: { userId: user.id },
        select: { provider: true },
      }),
      this.passkeys.hasStepUpPasskey(user.id),
    ]);
    return {
      password:
        !!user.password || (!!user.ldapDN && !!this.config.get("ldap.enabled")),
      totp: user.totpVerified,
      passkey,
      providers: providers.map(({ provider }) => provider),
    };
  }

  @Post("step-up/passkey")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  stepUpPasskey(@GetUser() user: User, @Body() dto: StepUpScopeDTO) {
    this.stepUp.assertMayConfirm(user, dto.scope);
    return this.passkeys.beginStepUp(user, dto.scope);
  }

  /**
   * Confirms the user's identity for one operation. The browser receives a
   * single-use confirmation that the operation spends.
   */
  @Post("step-up")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  @HttpCode(200)
  async confirmStepUp(
    @GetUser() user: User,
    @Body() dto: StepUpDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.stepUp.assertMayConfirm(user, dto.scope);
    let method: StepUpMethod;
    try {
      if (dto.passkey) {
        await this.passkeys.verifyStepUp(user, dto.scope, dto.passkey);
        method = "passkey";
      } else {
        method = await this.authTotpService.confirmSecondFactorChange(
          user,
          {
            password: dto.password,
            reauthProof: request.cookies?.[OAUTH_REAUTH_COOKIE],
          },
          dto.code,
          "STEP_UP",
        );
        this.clearReauthProof(response);
      }
    } catch (error) {
      this.stepUp.recordRefusal(user, dto.scope);
      throw error;
    }
    const { value, expiresAt } = await this.stepUp.issue(
      user,
      dto.scope,
      method,
    );
    response.cookie(STEP_UP_COOKIE, value, {
      path: STEP_UP_COOKIE_PATH,
      sameSite: "strict",
      secure: this.config.get("general.secureCookies"),
      httpOnly: true,
      maxAge: STEP_UP_TTL_MS,
    });
    return { expiresAt };
  }

  private clearReauthProof(response: Response) {
    response.clearCookie(OAUTH_REAUTH_COOKIE, {
      path: OAUTH_REAUTH_COOKIE_PATH,
      sameSite: "strict",
      secure: this.config.get("general.secureCookies"),
      httpOnly: true,
    });
  }
}
