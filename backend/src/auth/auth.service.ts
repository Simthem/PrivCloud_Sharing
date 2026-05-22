import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { User, Prisma } from "@prisma/client";
import * as argon from "argon2";
import { Request, Response } from "express";
import moment from "moment";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import { OAuthService } from "../oauth/oauth.service";
import { GenericOidcProvider } from "../oauth/provider/genericOidc.provider";
import { UserSevice } from "../user/user.service";
import { AuthRegisterDTO } from "./dto/authRegister.dto";
import { AuthSignInDTO } from "./dto/authSignIn.dto";
import { LdapService } from "./ldap.service";

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private emailService: EmailService,
    private ldapService: LdapService,
    private userService: UserSevice,
    @Inject(forwardRef(() => OAuthService)) private oAuthService: OAuthService,
  ) {}
  private readonly logger = new Logger(AuthService.name);

  async signUp(dto: AuthRegisterDTO, ip: string, isAdmin?: boolean) {
    const isFirstUser = (await this.prisma.user.count()) == 0;

    const hash = dto.password ? await argon.hash(dto.password) : null;
    try {
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          username: dto.username,
          password: hash,
          isAdmin: isAdmin ?? isFirstUser,
        },
      });

      const { refreshToken, refreshTokenId } = await this.createRefreshToken(
        user.id,
      );
      const accessToken = await this.createAccessToken(user, refreshTokenId);

      this.logger.log(`User ${user.email} signed up from IP ${ip}`);
      return { accessToken, refreshToken, user };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code == "P2002") {
          const duplicatedField: string = e.meta.target[0];
          throw new BadRequestException(
            `A user with this ${duplicatedField} already exists`,
          );
        }
      }
    }
  }

  private readonly MAX_LOGIN_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION_MINUTES = 15;

  async signIn(dto: AuthSignInDTO, ip: string) {
    if (!dto.email && !dto.username) {
      throw new BadRequestException("Email or username is required");
    }

    // Lookup user for lockout check
    const targetUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(dto.email ? [{ email: dto.email }] : []),
          ...(dto.username ? [{ username: dto.username }] : []),
        ],
      },
    });

    // Check lockout
    if (targetUser?.lockedUntil && targetUser.lockedUntil > new Date()) {
      this.logger.warn(
        `Locked account login attempt for ${dto.email || dto.username} from IP ${ip}`,
      );
      throw new ForbiddenException(
        "Account temporarily locked due to too many failed attempts. Please try again later.",
      );
    }

    if (!this.config.get("oauth.disablePassword")) {
      if (
        targetUser?.password &&
        (await argon.verify(targetUser.password, dto.password))
      ) {
        // Reset failed attempts on successful login
        if (targetUser.failedLoginAttempts > 0) {
          await this.prisma.user.update({
            where: { id: targetUser.id },
            data: { failedLoginAttempts: 0, lockedUntil: null },
          });
        }
        this.logger.log(
          `Successful password login for user ${targetUser.email} from IP ${ip}`,
        );
        return this.generateToken(targetUser);
      }
    }

    if (this.config.get("ldap.enabled")) {
      const ldapUsername = dto.username || dto.email;
      this.logger.debug(`Trying LDAP login for user ${ldapUsername}`);
      const ldapUser = await this.ldapService.authenticateUser(
        ldapUsername,
        dto.password,
      );
      if (ldapUser) {
        const user = await this.userService.findOrCreateFromLDAP(dto, ldapUser);
        // Reset failed attempts on successful LDAP login
        if (user.failedLoginAttempts > 0) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: 0, lockedUntil: null },
          });
        }
        this.logger.log(
          `Successful LDAP login for user ${ldapUsername} (${user.id}) from IP ${ip}`,
        );
        return this.generateToken(user);
      }
    }

    // Increment failed attempts
    if (targetUser) {
      const attempts = targetUser.failedLoginAttempts + 1;
      const lockout =
        attempts >= this.MAX_LOGIN_ATTEMPTS
          ? new Date(Date.now() + this.LOCKOUT_DURATION_MINUTES * 60 * 1000)
          : null;

      await this.prisma.user.update({
        where: { id: targetUser.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lockout,
        },
      });

      if (lockout) {
        this.logger.warn(
          `Account ${targetUser.email} locked after ${attempts} failed attempts from IP ${ip}`,
        );
      }
    }

    this.logger.log(
      `Failed login attempt for user ${dto.email || dto.username} from IP ${ip}`,
    );
    throw new UnauthorizedException("Wrong email or password");
  }

  async generateToken(user: User, oauth?: { idToken?: string }) {
    // Invalidate all old loginTokens when a new one is created
    await this.prisma.loginToken.deleteMany({ where: { userId: user.id } });

    // Check if the user has TOTP enabled
    if (user.totpVerified && !(oauth && this.config.get("oauth.ignoreTotp"))) {
      const loginToken = await this.createLoginToken(user.id);

      return { loginToken };
    }

    const { refreshToken, refreshTokenId } = await this.createRefreshToken(
      user.id,
      oauth?.idToken,
    );
    const accessToken = await this.createAccessToken(user, refreshTokenId);

    return { accessToken, refreshToken };
  }

  async requestResetPassword(email: string) {
    if (this.config.get("oauth.disablePassword"))
      throw new ForbiddenException("Password sign in is disabled");

    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { resetPasswordToken: true },
    });

    if (!user) return;

    if (user.ldapDN) {
      this.logger.log(
        `Failed password reset request for user ${email} because it is an LDAP user`,
      );
      throw new BadRequestException(
        "This account can't reset its password here. Please contact your administrator.",
      );
    }

    // Delete old reset password token
    if (user.resetPasswordToken) {
      await this.prisma.resetPasswordToken.delete({
        where: { token: user.resetPasswordToken.token },
      });
    }

    const { token } = await this.prisma.resetPasswordToken.create({
      data: {
        expiresAt: moment().add(1, "hour").toDate(),
        user: { connect: { id: user.id } },
      },
    });

    this.emailService.sendResetPasswordEmail(user.email, token);
  }

  async resetPassword(token: string, newPassword: string) {
    if (this.config.get("oauth.disablePassword"))
      throw new ForbiddenException("Password sign in is disabled");

    const resetToken = await this.prisma.resetPasswordToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!resetToken) throw new BadRequestException("Token invalid or expired");

    if (resetToken.expiresAt < new Date()) {
      await this.prisma.resetPasswordToken.delete({ where: { token } });
      throw new BadRequestException("Token expired. Please request a new password reset.");
    }

    const newPasswordHash = await argon.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.resetPasswordToken.delete({ where: { token } });
      await tx.user.update({
        where: { id: resetToken.user.id },
        data: { password: newPasswordHash },
      });
      // Invalidate all sessions on password reset
      await tx.refreshToken.deleteMany({ where: { userId: resetToken.user.id } });
    });
  }

  async updatePassword(user: User, newPassword: string, oldPassword?: string) {
    const isPasswordValid =
      !user.password || (await argon.verify(user.password, oldPassword));

    if (!isPasswordValid) throw new ForbiddenException("Invalid password");

    const hash = await argon.hash(newPassword);

    await this.prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hash },
    });

    return this.createRefreshToken(user.id);
  }

  async createAccessToken(user: User, refreshTokenId: string) {
    return this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        isAdmin: user.isAdmin,
        refreshTokenId,
      },
      {
        expiresIn: "15min",
        secret: this.config.get("internal.jwtSecret"),
      },
    );
  }

  async signOut(accessToken: string) {
    let refreshTokenId: string | undefined;
    try {
      const payload = this.jwtService.verify(accessToken, {
        secret: this.config.get("internal.jwtSecret"),
      }) as { refreshTokenId?: string };
      refreshTokenId = payload.refreshTokenId;
    } catch {
      // Token expired but signature is still valid - allow graceful sign-out.
      // Using verify() with ignoreExpiration instead of decode() ensures
      // the token signature is cryptographically validated, preventing an
      // attacker from forging a token with an arbitrary refreshTokenId.
      try {
        const payload = this.jwtService.verify(accessToken, {
          secret: this.config.get("internal.jwtSecret"),
          ignoreExpiration: true,
        }) as { refreshTokenId?: string };
        refreshTokenId = payload.refreshTokenId;
      } catch {
        // Signature invalid - reject entirely
        return;
      }
    }

    if (!refreshTokenId) {
      return;
    }

    const oauthIDToken = await this.prisma.refreshToken
      .findFirst({
        select: { oauthIDToken: true, userId: true },
        where: { id: refreshTokenId },
      })
      .then((refreshToken) => {
        this.logger.debug(`Sign out for user ${refreshToken?.userId} `);
        return refreshToken?.oauthIDToken;
      })
      .catch((e) => {
        // Ignore error if refresh token doesn't exist
        if (e.code != "P2025") throw e;
      });
    await this.prisma.refreshToken
      .delete({ where: { id: refreshTokenId } })
      .catch((e) => {
        // Ignore error if refresh token doesn't exist
        if (e.code != "P2025") throw e;
      });

    if (typeof oauthIDToken === "string") {
      const [providerName, idTokenHint] = oauthIDToken.split(":");
      const provider = this.oAuthService.availableProviders()[providerName];
      let signOutFromProviderSupportedAndActivated = false;
      try {
        signOutFromProviderSupportedAndActivated = this.config.get(
          `oauth.${providerName}-signOut`,
        );
      } catch {
        // Ignore error if the provider is not supported or if the provider sign out is not activated
      }
      if (
        provider instanceof GenericOidcProvider &&
        signOutFromProviderSupportedAndActivated
      ) {
        const configuration = await provider.getConfiguration();
        if (URL.canParse(configuration.end_session_endpoint)) {
          const redirectURI = new URL(configuration.end_session_endpoint);
          redirectURI.searchParams.append(
            "post_logout_redirect_uri",
            this.config.get("general.appUrl"),
          );
          redirectURI.searchParams.append("id_token_hint", idTokenHint);
          redirectURI.searchParams.append(
            "client_id",
            this.config.get(`oauth.${providerName}-clientId`),
          );
          return redirectURI.toString();
        }
      }
    }
  }

  async refreshAccessToken(refreshToken: string) {
    const refreshTokenMetaData = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!refreshTokenMetaData || refreshTokenMetaData.expiresAt < new Date())
      throw new UnauthorizedException();

    // Rotate: delete old token and create new one
    await this.prisma.refreshToken.delete({ where: { token: refreshToken } });

    const { refreshToken: newRefreshToken, refreshTokenId } =
      await this.createRefreshToken(
        refreshTokenMetaData.user.id,
        refreshTokenMetaData.oauthIDToken,
      );

    const accessToken = await this.createAccessToken(
      refreshTokenMetaData.user,
      refreshTokenId,
    );

    return { accessToken, refreshToken: newRefreshToken };
  }

  async createRefreshToken(userId: string, idToken?: string) {
    const sessionDuration = this.config.get("general.sessionDuration");
    const { id, token } = await this.prisma.refreshToken.create({
      data: {
        userId,
        expiresAt: moment()
          .add(sessionDuration.value, sessionDuration.unit)
          .toDate(),
        oauthIDToken: idToken,
      },
    });

    return { refreshTokenId: id, refreshToken: token };
  }

  async createLoginToken(userId: string) {
    const loginToken = (
      await this.prisma.loginToken.create({
        data: { userId, expiresAt: moment().add(5, "minutes").toDate() },
      })
    ).token;

    return loginToken;
  }

  addTokensToResponse(
    response: Response,
    refreshToken?: string,
    accessToken?: string,
  ) {
    const isSecure = this.config.get("general.secureCookies");
    if (accessToken)
      response.cookie("access_token", accessToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: isSecure,
        maxAge: 1000 * 60 * 13, // 13 min (JWT lives 15 min - 2 min safety margin)
      });
    if (refreshToken) {
      const now = moment();
      const sessionDuration = this.config.get("general.sessionDuration");
      const maxAge = moment(now)
        .add(sessionDuration.value, sessionDuration.unit)
        .diff(now);
      response.cookie("refresh_token", refreshToken, {
        path: "/api/auth/token",
        httpOnly: true,
        sameSite: "strict",
        secure: isSecure,
        maxAge,
      });
      // Non-httpOnly marker so the client can detect an active session
      // even after the short-lived access_token cookie has expired.
      // httpOnly: false - intentional. Contains no sensitive data (value: "1").
      response.cookie("logged_in", "1", {
        httpOnly: false,
        sameSite: "strict",
        secure: isSecure,
        maxAge,
      });
    }
  }

  /**
   * Returns the user id if the user is logged in, null otherwise
   */
  async getIdOfCurrentUser(request: Request): Promise<string | null> {
    if (!request.cookies.access_token) return null;
    try {
      const payload = await this.jwtService.verifyAsync(
        request.cookies.access_token,
        {
          secret: this.config.get("internal.jwtSecret"),
        },
      );
      return payload.sub;
    } catch {
      return null;
    }
  }

  async verifyPassword(user: User, password: string) {
    if (!user.password && this.config.get("ldap.enabled")) {
      const ldapUser = await this.ldapService.authenticateUser(user.username, password);
      return !!ldapUser;
    }

    if (!user.password) return false;

    return argon.verify(user.password, password);
  }
}
