import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { Request, Response } from "express";
import { nanoid } from "nanoid";
import { AuthService } from "../auth/auth.service";
import { GetUser } from "../auth/decorator/getUser.decorator";
import { JwtGuard } from "../auth/guard/jwt.guard";
import { ConfigService } from "../config/config.service";
import { OAuthCallbackDto } from "./dto/oauthCallback.dto";
import { ErrorPageExceptionFilter } from "./filter/errorPageException.filter";
import { OAuthGuard } from "./guard/oauth.guard";
import { ProviderGuard } from "./guard/provider.guard";
import { OAuthService } from "./oauth.service";
import { OAuthProvider } from "./provider/oauthProvider.interface";
import { OAuthExceptionFilter } from "./filter/oauthException.filter";
import { SafeIdPipe } from "../share/pipe/safeId.pipe";

import {
  OAUTH_REAUTH_INTENT_TTL_MS,
  OAUTH_REAUTH_MAX_AUTH_AGE_MS,
  OAUTH_REAUTH_COOKIE,
  OAUTH_REAUTH_COOKIE_PATH,
  OAUTH_REAUTH_PROOF_TTL_MS,
  OAuthReauthService,
} from "../auth/oauthReauth.service";
import { ErrorPageException } from "./exceptions/errorPage.exception";
import { StepUpService } from "../auth/stepUp.service";

// Pages a confirmation started from may send the user back to: the account,
// the administration and the signing pages, nothing else.
const isStepUpReturn = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\/(?:account|admin(?:\/[A-Za-z0-9_-]+)*|sign\/[0-9A-Fa-f-]{36})$/.test(
    value,
  );

// Time for the provider's sign-in, between the link request and the callback.
const OAUTH_LINK_TTL_MS = 10 * 60 * 1000;

@Controller("oauth")
export class OAuthController {
  private readonly logger = new Logger("OAuthController");

  constructor(
    private authService: AuthService,
    private oauthService: OAuthService,
    private config: ConfigService,
    private oauthReauth: OAuthReauthService,
    @Inject("OAUTH_PROVIDERS")
    private providers: Record<string, OAuthProvider<unknown>>,
    private stepUp: StepUpService,
  ) {}

  @Get("available")
  available() {
    return this.oauthService.available();
  }

  @Get("status")
  @UseGuards(JwtGuard)
  async status(@GetUser() user: User) {
    if (!user) throw new UnauthorizedException();
    return this.oauthService.status(user);
  }

  @Get("auth/:provider")
  @UseGuards(ProviderGuard)
  @UseFilters(ErrorPageExceptionFilter)
  async auth(
    @Param("provider") provider: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Query("link") link?: string,
  ) {
    const state = nanoid(16);
    const isSecure = this.config.get("general.secureCookies");

    // A linked provider signs in for good and confirms an administrator's
    // sensitive operations. Linking one to an administrator, asked for from
    // the account page, is confirmed here, where the step-up cookie is sent:
    // the provider's return to the callback is cross-site, so the callback
    // gets its own single-use grant. A sign-in asks for nothing, even in a
    // browser signed in as an administrator.
    const signedIn =
      link === "1" ? await this.authService.getIdOfCurrentUser(request) : null;
    const admin = signedIn
      ? await this.oauthService.findAdministrator(signedIn)
      : null;
    if (admin) {
      const scope = `oauth.link:${provider}`;
      try {
        await this.stepUp.consume(request, admin, scope);
      } catch {
        throw new ErrorPageException("step_up_required", "/account");
      }
      response.cookie(
        `oauth_${provider}_link`,
        await this.stepUp.handOver(admin, scope, OAUTH_LINK_TTL_MS),
        {
          sameSite: "lax",
          secure: isSecure,
          httpOnly: true,
          maxAge: OAUTH_LINK_TTL_MS,
        },
      );
    }
    const { url, nonce } =
      await this.providers[provider].getAuthEndpoint(state);
    // Store state (and optional nonce for OIDC providers) in a single
    // httpOnly cookie so validation does not depend on the cache layer.
    const cookieValue = nonce ? `${state}|${nonce}` : state;
    response.cookie(`oauth_${provider}_state`, cookieValue, {
      sameSite: "lax",
      secure: isSecure,
      httpOnly: true,
      maxAge: 1000 * 60 * 10, // 10 minutes for OAuth flow
    });

    response.redirect(url);
  }

  /**
   * Re-authentication with a provider already linked to the signed-in
   * account, to confirm 2FA changes without the password, the first password
   * of an account that has none (?purpose=password), an email change
   * (?purpose=email) or a sensitive operation (?purpose=step-up, back to the
   * page named by ?return=). Started here, same-site, where the session cookie is
   * present: the provider's redirect to the callback is cross-site and never
   * carries it.
   */
  @Get("reauth/:provider")
  @UseGuards(JwtGuard, ProviderGuard)
  @UseFilters(ErrorPageExceptionFilter)
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  async reauth(
    @Param("provider", SafeIdPipe) provider: string,
    @GetUser() user: User,
    @Res({ passthrough: true }) response: Response,
    @Query("purpose") purpose?: string,
    @Query("return") returnTo?: string,
  ) {
    if (!(await this.oauthService.isLinked(user.id, provider))) {
      throw new ErrorPageException("not_linked", "/account", [
        `provider_${provider}`,
      ]);
    }
    const state = nanoid(16);
    const isSecure = this.config.get("general.secureCookies");
    const { url, nonce } = await this.providers[provider].getAuthEndpoint(
      state,
      { reauthenticate: true },
    );
    response.cookie(
      `oauth_${provider}_state`,
      nonce ? `${state}|${nonce}` : state,
      {
        sameSite: "lax",
        secure: isSecure,
        httpOnly: true,
        maxAge: OAUTH_REAUTH_INTENT_TTL_MS,
      },
    );
    response.cookie(
      `oauth_${provider}_reauth`,
      await this.oauthReauth.startIntent(
        user.id,
        provider,
        purpose === "email"
          ? "EMAIL"
          : purpose === "password"
            ? "PASSWORD"
            : purpose === "step-up"
              ? "STEP_UP"
              : "TOTP",
      ),
      {
        sameSite: "lax",
        secure: isSecure,
        httpOnly: true,
        maxAge: OAUTH_REAUTH_INTENT_TTL_MS,
      },
    );
    if (purpose === "step-up" && isStepUpReturn(returnTo)) {
      response.cookie(`oauth_${provider}_return`, returnTo, {
        sameSite: "lax",
        secure: isSecure,
        httpOnly: true,
        maxAge: OAUTH_REAUTH_INTENT_TTL_MS,
      });
    }
    response.redirect(url);
  }

  @Get("callback/:provider")
  @UseGuards(ProviderGuard, OAuthGuard)
  @UseFilters(ErrorPageExceptionFilter, OAuthExceptionFilter)
  async callback(
    @Param("provider") provider: string,
    @Query() query: OAuthCallbackDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Extract the optional nonce from the compound cookie value (state|nonce).
    const cookieValue: string =
      request.cookies[`oauth_${provider}_state`] ?? "";
    const pipeIdx = cookieValue.indexOf("|");
    if (pipeIdx !== -1) {
      query.nonce = cookieValue.substring(pipeIdx + 1);
    }

    // State has been validated by OAuthGuard -- clear the one-time cookie
    const isSecure = this.config.get("general.secureCookies");
    response.clearCookie(`oauth_${provider}_state`, {
      sameSite: "lax",
      secure: isSecure,
      httpOnly: true,
    });

    // Set by reauth(): this flow confirms an identity, it never signs in or
    // links anything.
    const reauthIntent: string | undefined =
      request.cookies[`oauth_${provider}_reauth`];
    if (reauthIntent) {
      response.clearCookie(`oauth_${provider}_reauth`, {
        sameSite: "lax",
        secure: isSecure,
        httpOnly: true,
      });
    }
    const linkGrant: unknown = request.cookies[`oauth_${provider}_link`];
    if (linkGrant !== undefined) {
      response.clearCookie(`oauth_${provider}_link`, {
        sameSite: "lax",
        secure: isSecure,
        httpOnly: true,
      });
    }
    const stepUpReturn: unknown = request.cookies[`oauth_${provider}_return`];
    if (stepUpReturn !== undefined) {
      response.clearCookie(`oauth_${provider}_return`, {
        sameSite: "lax",
        secure: isSecure,
        httpOnly: true,
      });
    }

    try {
      const oauthToken = await this.providers[provider].getToken(query);
      const user = await this.providers[provider].getUserInfo(
        oauthToken,
        query,
      );
      if (reauthIntent) {
        await this.completeReauth(
          provider,
          reauthIntent,
          user,
          response,
          isStepUpReturn(stepUpReturn) ? stepUpReturn : undefined,
        );
        return;
      }

      const id = await this.authService.getIdOfCurrentUser(request);

      if (id) {
        const admin = await this.oauthService.findAdministrator(id);
        if (
          admin &&
          !(await this.stepUp.spend(
            admin.id,
            `oauth.link:${provider}`,
            linkGrant,
          ))
        ) {
          this.logger.warn(
            `Refused to link ${provider} to administrator ${admin.id} without a confirmation`,
          );
          throw new ErrorPageException("step_up_required", "/account");
        }
        await this.oauthService.link(
          id,
          provider,
          user.providerId,
          user.providerUsername,
        );
        response.redirect(this.config.get("general.appUrl") + "/account");
      } else {
        const token: {
          accessToken?: string;
          refreshToken?: string;
          loginToken?: string;
        } = await this.oauthService.signIn(user, request.ip);
        if (token.accessToken) {
          this.authService.addTokensToResponse(
            response,
            token.refreshToken,
            token.accessToken,
          );
          response.redirect(this.config.get("general.appUrl"));
        } else {
          response.redirect(
            this.config.get("general.appUrl") +
              `/auth/totp/${token.loginToken}`,
          );
        }
      }
    } catch (error) {
      if (reauthIntent && error instanceof ErrorPageException) throw error;
      this.logger.error("OAuth callback failed");
      // Re-throw HttpException / ErrorPageException so NestJS filters handle them
      if (
        error instanceof ErrorPageException ||
        (error instanceof Error && (error as any).status)
      ) {
        throw error;
      }
      // For non-HTTP errors, ensure a response is still sent
      if (!response.headersSent) {
        const appUrl = this.config.get("general.appUrl");
        response.redirect(
          `${appUrl}/error?error=default&redirect=/auth/signIn`,
        );
      }
    }
  }

  /**
   * The intent names the account, once. The provider must return the very
   * identity linked to it, recently authenticated when the provider says when.
   */
  private async completeReauth(
    provider: string,
    intent: string,
    identity: { providerId: string; authTime?: number },
    response: Response,
    stepUpReturn?: string,
  ) {
    const confirmed = await this.oauthReauth.consumeIntent(intent, provider);
    if (!confirmed) throw new ErrorPageException("reauth_expired", "/account");
    const { userId, purpose } = confirmed;
    const linked = await this.oauthService.isLinked(
      userId,
      provider,
      identity.providerId,
    );
    if (!linked) {
      this.logger.warn("OAuth re-authentication returned another identity");
      throw new ErrorPageException("reauth_mismatch", "/account", [
        `provider_${provider}`,
      ]);
    }
    // A first password, a new email or an administrator's operation outlives
    // every session: only a provider that states when the user actually
    // signed in (OIDC auth_time) may confirm one.
    if (
      (purpose === "PASSWORD" ||
        purpose === "EMAIL" ||
        purpose === "STEP_UP") &&
      identity.authTime === undefined
    ) {
      throw new ErrorPageException("reauth_unsupported", "/account", [
        `provider_${provider}`,
      ]);
    }
    if (
      identity.authTime !== undefined &&
      Date.now() - identity.authTime * 1000 > OAUTH_REAUTH_MAX_AUTH_AGE_MS
    ) {
      throw new ErrorPageException("reauth_expired", "/account");
    }
    response.cookie(
      OAUTH_REAUTH_COOKIE,
      await this.oauthReauth.issueProof(userId, provider, purpose),
      {
        path: OAUTH_REAUTH_COOKIE_PATH,
        sameSite: "strict",
        secure: this.config.get("general.secureCookies"),
        httpOnly: true,
        maxAge: OAUTH_REAUTH_PROOF_TTL_MS,
      },
    );
    response.redirect(
      this.config.get("general.appUrl") +
        (purpose === "PASSWORD"
          ? "/account?passwordReauth=1"
          : purpose === "EMAIL"
            ? "/account?emailReauth=1"
            : purpose === "STEP_UP"
              ? `${stepUpReturn ?? "/admin"}?stepUpReauth=1`
              : "/account?totpReauth=1"),
    );
  }

  @Post("unlink/:provider")
  @UseGuards(JwtGuard, ProviderGuard)
  @UseFilters(ErrorPageExceptionFilter)
  disconnectProvider(
    @GetUser() user: User,
    @Param("provider", SafeIdPipe) provider: string,
  ) {
    // No filesystem path is built from `provider`: the service resolves the
    // OAuthUser row with prisma.oAuthUser.findFirst() and deletes it by primary
    // key. `provider` is constrained twice before reaching here - ProviderGuard
    // accepts only registered provider names, and SafeIdPipe rejects `/`, `\`,
    // `..` and NUL. The route stays /oauth/unlink/:provider for API stability.
    return this.oauthService.disconnectProvider(user, provider);
  }
}
