import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { User, Prisma } from "@prisma/client";
import * as argon from "argon2";
import * as crypto from "crypto";
import { Request, Response } from "express";
import moment from "moment";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { EmailVerificationService } from "src/emailVerification/emailVerification.service";
import { assertEmailVerificationAccess } from "src/emailVerification/emailVerification.util";
import { PrismaService } from "src/prisma/prisma.service";
import { createUserUniqueConflictResponse } from "src/prisma/prisma-error.util";
import { OAuthService } from "../oauth/oauth.service";
import { GenericOidcProvider } from "../oauth/provider/genericOidc.provider";
import { UserSevice } from "../user/user.service";
import { AuthRegisterDTO } from "./dto/authRegister.dto";
import { AuthSignInDTO } from "./dto/authSignIn.dto";
import { LdapService } from "./ldap.service";
import { OAuthReauthService } from "./oauthReauth.service";
import {
  LoginBackoffPolicy,
  LoginFailureState,
  nextLoginFailureState,
} from "./loginBackoff.util";
import {
  decryptRefreshReplay,
  encryptRefreshReplay,
  RefreshReplayTokens,
} from "./refresh-replay.util";

// A failed sign-in retries its compare-and-set write this many times before
// falling back to a plain increment.
const LOGIN_FAILURE_WRITE_ATTEMPTS = 8;

/** A failure counted ahead of its check, and what it found and changed. */
type LoginReservation = LoginFailureState & {
  blocked: boolean;
  lockOwned: boolean;
};

@Injectable()
export class AuthService {
  private signUpQueue: Promise<void> = Promise.resolve();
  private readonly refreshReplayGraceMs = 15_000;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private emailService: EmailService,
    private emailVerificationService: EmailVerificationService,
    private ldapService: LdapService,
    private userService: UserSevice,
    @Inject(forwardRef(() => OAuthService)) private oAuthService: OAuthService,
    private oauthReauth: OAuthReauthService,
  ) {}
  private readonly logger = new Logger(AuthService.name);

  async signUp(
    dto: AuthRegisterDTO,
    _ip: string,
    isAdmin?: boolean,
    emailAlreadyVerified = false,
  ) {
    // An instance with no SMTP can never deliver the link. Refusing every
    // registration there would be worse than not verifying: the account is
    // created already verified, exactly like those predating this feature.
    const verificationRequired =
      !emailAlreadyVerified &&
      this.emailVerificationService.isDeliveryAvailable();
    const verificationRequiredAt = new Date();
    const hash = dto.password ? await argon.hash(dto.password) : null;
    try {
      let releaseQueue!: () => void;
      const previousSignUp = this.signUpQueue;
      this.signUpQueue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      await previousSignUp;

      let user: User;
      try {
        // The public distribution uses SQLite and a single backend process.
        // Serialize bootstrap registrations in-process so only one request can
        // observe an empty user table and receive administrator privileges.
        user = await this.prisma.$transaction(async (transaction) => {
          const isFirstUser = (await transaction.user.count()) === 0;
          const createdUser = await transaction.user.create({
            data: {
              email: dto.email,
              username: dto.username,
              password: hash,
              isAdmin: isAdmin ?? isFirstUser,
              emailVerificationRequiredAt: verificationRequiredAt,
              emailVerifiedAt: verificationRequired
                ? null
                : verificationRequiredAt,
            },
          });
          if (verificationRequired) {
            await this.emailVerificationService.issueInTransaction(
              transaction,
              createdUser,
            );
          }
          return createdUser;
        });
      } finally {
        releaseQueue();
      }

      if (verificationRequired) {
        await this.emailVerificationService.deliverPending();
      }

      const { refreshToken, refreshTokenId } = await this.createRefreshToken(
        user.id,
      );
      const accessToken = await this.createAccessToken(user, refreshTokenId);

      this.logger.log(`User ${user.id} signed up`);
      // SECURITY: Strip sensitive fields before returning
      const { password: _pw, ...safeUser } = user;
      return { accessToken, refreshToken, user: safeUser };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code == "P2002") {
          throw new BadRequestException(createUserUniqueConflictResponse(e));
        }
      }
      throw e;
    }
  }

  private loginBackoffPolicy(): LoginBackoffPolicy {
    const baseLockMinutes = this.config.get("security.loginBaseLockMinutes");
    return {
      maxFailures: this.config.get("security.loginMaxFailures"),
      baseLockMinutes,
      maxLockMinutes: Math.max(
        baseLockMinutes,
        this.config.get("security.loginMaxLockMinutes"),
      ),
      failureWindowMinutes: this.config.get(
        "security.loginFailureWindowMinutes",
      ),
    };
  }

  private lockedLogin(until: Date): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: "Too many failed login attempts. Please try again later.",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((until.getTime() - Date.now()) / 1000),
        ),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Concurrent failures must not overwrite each other: each one is written
   * only over the state it was computed from, and recomputed from a fresh read
   * otherwise. Under persistent contention it is still counted.
   */
  private async recordLoginFailure(
    user: Pick<
      User,
      "id" | "failedLoginAttempts" | "lastFailedLoginAt" | "lockedUntil"
    >,
  ) {
    let current = user;
    for (let attempt = 0; attempt < LOGIN_FAILURE_WRITE_ATTEMPTS; attempt++) {
      const failure = nextLoginFailureState({
        previousAttempts: current.failedLoginAttempts,
        lastFailedLoginAt: current.lastFailedLoginAt,
        previousLockedUntil: current.lockedUntil,
        policy: this.loginBackoffPolicy(),
      });
      const { count } = await this.prisma.user.updateMany({
        where: {
          id: current.id,
          failedLoginAttempts: current.failedLoginAttempts,
          lastFailedLoginAt: current.lastFailedLoginAt,
          lockedUntil: current.lockedUntil,
        },
        data: {
          failedLoginAttempts: failure.attempts,
          lockedUntil: failure.lockedUntil,
          lastFailedLoginAt: failure.lastFailedLoginAt,
        },
      });
      // An attempt counted over a lock still running is refused unchecked.
      // The lock is only ever given back by the attempt that set it.
      if (count === 1)
        return {
          ...failure,
          blocked: !!current.lockedUntil && current.lockedUntil > new Date(),
          lockOwned: !!failure.lockedUntil,
        };

      const fresh = await this.prisma.user.findUnique({
        where: { id: current.id },
        select: {
          id: true,
          failedLoginAttempts: true,
          lastFailedLoginAt: true,
          lockedUntil: true,
        },
      });
      if (!fresh) return { ...failure, blocked: false, lockOwned: false };
      current = fresh;
    }

    const now = new Date();
    const { count } = await this.prisma.user.updateMany({
      where: { id: current.id },
      data: { failedLoginAttempts: { increment: 1 }, lastFailedLoginAt: now },
    });
    const counted =
      count === 1 &&
      (await this.prisma.user.findUnique({
        where: { id: current.id },
        select: { failedLoginAttempts: true, lockedUntil: true },
      }));
    // The account is gone: there is nothing left to lock.
    if (!counted) {
      return {
        attempts: 0,
        lastFailedLoginAt: now,
        lockedUntil: null,
        retryAfterSeconds: 0,
        blocked: false,
        lockOwned: false,
      };
    }
    const failure = nextLoginFailureState({
      previousAttempts: counted.failedLoginAttempts - 1,
      lastFailedLoginAt: now,
      previousLockedUntil: counted.lockedUntil,
      now,
      policy: this.loginBackoffPolicy(),
    });
    if (failure.lockedUntil) {
      // Only ever extends a lock another request may have set meanwhile.
      await this.prisma.user.updateMany({
        where: {
          id: current.id,
          OR: [
            { lockedUntil: null },
            { lockedUntil: { lt: failure.lockedUntil } },
          ],
        },
        data: { lockedUntil: failure.lockedUntil },
      });
    }
    if (
      counted.lockedUntil &&
      counted.lockedUntil > (failure.lockedUntil ?? now)
    ) {
      return {
        ...failure,
        lockedUntil: counted.lockedUntil,
        blocked: true,
        lockOwned: false,
      };
    }
    return {
      ...failure,
      blocked: !!counted.lockedUntil && counted.lockedUntil > now,
      lockOwned: false,
    };
  }

  /**
   * A successful sign-in clears the failure count, but never a lock that a
   * concurrent failure set after this request checked it.
   */
  async clearLoginFailures(userId: string) {
    const now = new Date();
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        failedLoginAttempts: { gt: 0 },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      },
    });
    if (count === 1) return;
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    if (current?.lockedUntil && current.lockedUntil > now)
      throw this.lockedLogin(current.lockedUntil);
  }

  async signIn(dto: AuthSignInDTO, _ip: string) {
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
        `Locked account login attempt for user ${targetUser.id}`,
      );
      throw this.lockedLogin(targetUser.lockedUntil);
    }

    // Counted before it is checked: concurrent guesses must not all pass the
    // lock above. Only those within the limit are checked, the one that
    // reaches it included. An unknown name has nothing to lock.
    const reserved = targetUser && (await this.recordLoginFailure(targetUser));
    if (reserved?.blocked) {
      this.logger.warn(
        `Locked account login attempt for user ${targetUser.id}`,
      );
      throw this.lockedLogin(reserved.lockedUntil ?? new Date());
    }

    if (!this.config.get("oauth.disablePassword")) {
      if (
        targetUser?.password &&
        (await argon.verify(targetUser.password, dto.password))
      ) {
        await this.passwordAccepted(targetUser, reserved);
        this.logger.log(`Successful password login for user ${targetUser.id}`);
        return this.generateToken(targetUser);
      }
    }

    if (this.config.get("ldap.enabled")) {
      const ldapUsername = dto.username || dto.email;
      this.logger.debug("Trying LDAP login");
      const ldapUser = await this.ldapService.authenticateUser(
        ldapUsername,
        dto.password,
      );
      if (ldapUser) {
        const user = await this.userService.findOrCreateFromLDAP(dto, ldapUser);
        // The name typed may belong to another local account than the
        // directory entry: that account gets its reserved attempt back.
        if (reserved && user.id !== targetUser.id) {
          await this.refundAttempt(targetUser.id, reserved);
        }
        await this.passwordAccepted(
          user,
          user.id === targetUser?.id ? reserved : undefined,
        );
        this.logger.log(`Successful LDAP login for user ${user.id}`);
        return this.generateToken(user);
      }
    }

    if (reserved?.lockedUntil) {
      this.logger.warn(
        `Account ${targetUser.id} locked after ${reserved.attempts} failed attempts`,
      );
      throw this.lockedLogin(reserved.lockedUntil);
    }

    this.logger.log("Failed login attempt");
    throw new UnauthorizedException("Wrong email or password");
  }

  /**
   * Sign-in with a passkey already verified by AccountPasskeyService. The
   * passkey proves possession and user verification, so it stands for both
   * factors: no TOTP code is asked on top. Lockout and every other access
   * rule of generateToken still apply.
   */
  async signInWithPasskey(user: User) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      this.logger.warn(`Locked account passkey sign-in for user ${user.id}`);
      throw this.lockedLogin(user.lockedUntil);
    }
    await this.clearLoginFailures(user.id);
    this.logger.log(`Successful passkey login for user ${user.id}`);
    return this.generateToken(user, undefined, {
      multiFactor: true,
    });
  }

  async generateToken(
    user: User,
    oauth?: { idToken?: string },
    options: { multiFactor?: boolean } = {},
  ) {
    assertEmailVerificationAccess(user);

    // Invalidate all old loginTokens when a new one is created
    await this.prisma.loginToken.deleteMany({ where: { userId: user.id } });

    // A verified flag without a secret is not a usable second factor.
    if (
      user.totpVerified &&
      !!user.totpSecret &&
      !options.multiFactor &&
      !(oauth && this.config.get("oauth.ignoreTotp"))
    ) {
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
      // Keep the public response indistinguishable from an unknown address.
      // Revealing that an account exists (and is LDAP-managed) would turn the
      // reset endpoint into an account-enumeration oracle.
      return;
    }

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const issued = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${user.id}`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || current.email !== email || current.ldapDN) return false;
      await tx.resetPasswordToken.deleteMany({ where: { userId: user.id } });
      await tx.resetPasswordToken.create({
        data: {
          token: tokenHash,
          userId: user.id,
          expiresAt: moment().add(1, "hour").toDate(),
        },
      });
      return true;
    });
    if (!issued) return;

    try {
      await this.emailService.sendResetPasswordEmail(user.email, rawToken);
    } catch {
      // Keep the anonymous 202 response identical for registered and unknown
      // addresses, while ensuring SMTP failures cannot become unhandled
      // promise rejections.
      this.logger.warn("Could not send a password-reset message");
    }
  }

  async resetPassword(token: string, newPassword: string) {
    if (this.config.get("oauth.disablePassword"))
      throw new ForbiddenException("Password sign in is disabled");

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const resetToken =
      (await this.prisma.resetPasswordToken.findUnique({
        where: { token: tokenHash },
        include: { user: true },
      })) ??
      // One-hour compatibility window for links created before hashed storage.
      (await this.prisma.resetPasswordToken.findUnique({
        where: { token },
        include: { user: true },
      }));

    if (!resetToken) throw new BadRequestException("Token invalid or expired");

    if (resetToken.expiresAt < new Date()) {
      await this.prisma.resetPasswordToken.delete({
        where: { token: resetToken.token },
      });
      throw new BadRequestException(
        "Token expired. Please request a new password reset.",
      );
    }

    const newPasswordHash = await argon.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${resetToken.user.id}`;
      const currentToken = await tx.resetPasswordToken.findUnique({
        where: { token: resetToken.token },
      });
      if (!currentToken || currentToken.expiresAt.getTime() <= Date.now())
        throw new BadRequestException("Token invalid or expired");
      await tx.resetPasswordToken.delete({
        where: { token: resetToken.token },
      });
      await tx.user.update({
        where: { id: resetToken.user.id },
        // The emailed link proves the account: the failure count restarts.
        data: {
          password: newPasswordHash,
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastFailedLoginAt: null,
        },
      });
      // Invalidate all sessions on password reset
      await tx.refreshToken.deleteMany({
        where: { userId: resetToken.user.id },
      });
      // A sign-in still waiting for its 2FA code was made with the old password.
      await tx.loginToken.deleteMany({
        where: { userId: resetToken.user.id },
      });
    });
  }

  /**
   * Without a current password, a session alone must not be enough to set one:
   * it would outlive the session and sign every other device out. Such an
   * account proves a fresh sign-in with its linked OAuth provider (or its
   * directory password), otherwise it goes through the emailed reset link.
   */
  async updatePassword(
    user: User,
    newPassword: string,
    oldPassword?: string,
    reauthProof?: string,
  ): Promise<void> {
    if (user.password) {
      if (!oldPassword || !(await this.verifyPassword(user, oldPassword)))
        throw new ForbiddenException("Invalid password");
    } else if (oldPassword) {
      if (!(await this.verifyPassword(user, oldPassword)))
        throw new ForbiddenException("Invalid password");
    } else if (
      !(await this.oauthReauth.consumeProof(reauthProof, user.id, "PASSWORD"))
    ) {
      throw new ForbiddenException("Sign in again with your linked account");
    }

    const hash = await argon.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { password: hash },
      });
      await tx.refreshToken.deleteMany({
        where: { userId: user.id },
      });
    });
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
        algorithm: "HS256",
      },
    );
  }

  async signOut(accessToken: string) {
    let refreshTokenId: string | undefined;
    try {
      const payload = this.jwtService.verify(accessToken, {
        secret: this.config.get("internal.jwtSecret"),
        algorithms: ["HS256"],
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
          algorithms: ["HS256"],
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
          const isLocalHttp =
            redirectURI.protocol === "http:" &&
            ["localhost", "127.0.0.1", "::1"].includes(redirectURI.hostname);
          if (redirectURI.protocol !== "https:" && !isLocalHttp) {
            this.logger.warn(
              `Refusing insecure OIDC logout endpoint for provider ${providerName}`,
            );
            return;
          }
          if (redirectURI.username || redirectURI.password) {
            this.logger.warn(
              `Refusing OIDC logout endpoint with embedded credentials for provider ${providerName}`,
            );
            return;
          }
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
    const hashedToken = this.hashRefreshToken(refreshToken);
    const now = new Date();

    await this.prisma.refreshTokenReplay.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    const metadata = await this.findRefreshToken(
      this.prisma,
      refreshToken,
      hashedToken,
    );
    if (!metadata || metadata.expiresAt <= now) {
      throw new UnauthorizedException();
    }
    assertEmailVerificationAccess(metadata.user);

    const existingReplay = await this.prisma.refreshTokenReplay.findUnique({
      where: { previousTokenHash: hashedToken },
    });
    if (existingReplay?.expiresAt && existingReplay.expiresAt > now) {
      return this.readRefreshReplay(existingReplay.encryptedResult);
    }

    const replayGraceExpiresAt = new Date(
      Math.min(
        metadata.expiresAt.getTime(),
        Date.now() + this.refreshReplayGraceMs,
      ),
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await this.findRefreshToken(
          tx,
          refreshToken,
          hashedToken,
        );
        if (!current || current.expiresAt <= new Date()) {
          throw new UnauthorizedException();
        }

        const replay = await tx.refreshTokenReplay.findUnique({
          where: { previousTokenHash: hashedToken },
        });
        if (replay?.expiresAt && replay.expiresAt > new Date()) {
          return this.readRefreshReplay(replay.encryptedResult);
        }

        await tx.refreshTokenReplay.create({
          data: {
            previousTokenHash: hashedToken,
            expiresAt: replayGraceExpiresAt,
          },
        });

        const { refreshToken: newRefreshToken, refreshTokenId } =
          await this.createRefreshTokenWithClient(
            tx,
            current.user.id,
            current.oauthIDToken,
          );
        const accessToken = await this.createAccessToken(
          current.user,
          refreshTokenId,
        );
        const result = {
          accessToken,
          refreshToken: newRefreshToken,
        };

        await tx.refreshToken.update({
          where: { token: current.token },
          data: { expiresAt: replayGraceExpiresAt },
        });
        await tx.refreshTokenReplay.update({
          where: { previousTokenHash: hashedToken },
          data: {
            encryptedResult: encryptRefreshReplay(result, this.jwtSecret()),
          },
        });

        return result;
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;

      const replay = await this.prisma.refreshTokenReplay.findUnique({
        where: { previousTokenHash: hashedToken },
      });
      if (replay?.expiresAt && replay.expiresAt > new Date()) {
        return this.readRefreshReplay(replay.encryptedResult);
      }
      throw new UnauthorizedException();
    }
  }

  private async findRefreshToken(
    client: Pick<Prisma.TransactionClient, "refreshToken">,
    rawToken: string,
    hashedToken: string,
  ) {
    return (
      (await client.refreshToken.findUnique({
        where: { token: hashedToken },
        include: { user: true },
      })) ??
      (await client.refreshToken.findUnique({
        where: { token: rawToken },
        include: { user: true },
      }))
    );
  }

  private readRefreshReplay(
    encryptedResult: string | null,
  ): RefreshReplayTokens {
    if (!encryptedResult) throw new UnauthorizedException();
    try {
      return decryptRefreshReplay(encryptedResult, this.jwtSecret());
    } catch {
      this.logger.warn("Rejected an invalid refresh replay record");
      throw new UnauthorizedException();
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002") ||
      (!!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002")
    );
  }

  async createRefreshToken(userId: string, idToken?: string) {
    return this.createRefreshTokenWithClient(this.prisma, userId, idToken);
  }

  private async createRefreshTokenWithClient(
    client: Pick<Prisma.TransactionClient, "refreshToken">,
    userId: string,
    idToken?: string,
  ) {
    const sessionDuration = this.config.get("general.sessionDuration");
    // SECURITY: Generate a cryptographically random token and store only
    // its HMAC-SHA256 hash in the DB. If the DB leaks, tokens are unusable.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = this.hashRefreshToken(rawToken);

    const { id } = await client.refreshToken.create({
      data: {
        token: hashedToken,
        userId,
        expiresAt: moment()
          .add(sessionDuration.value, sessionDuration.unit)
          .toDate(),
        oauthIDToken: idToken,
      },
    });

    return { refreshTokenId: id, refreshToken: rawToken };
  }

  /** Compute HMAC-SHA256 of a refresh token using the JWT secret as key. */
  private hashRefreshToken(token: string): string {
    return crypto
      .createHmac("sha256", this.jwtSecret())
      .update(token)
      .digest("hex");
  }

  private jwtSecret(): string {
    const secret =
      this.config.get("internal.jwtSecret") || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        "FATAL: No JWT secret configured. Set internal.jwtSecret in config or JWT_SECRET env var.",
      );
    }
    return secret;
  }

  async createLoginToken(userId: string) {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    await this.prisma.loginToken.create({
      data: {
        token: tokenHash,
        userId,
        expiresAt: moment().add(5, "minutes").toDate(),
      },
    });
    return rawToken;
  }

  addTokensToResponse(
    response: Response,
    refreshToken?: string,
    accessToken?: string,
  ) {
    const isSecure = this.config.get("general.secureCookies");
    if (accessToken)
      response.cookie("access_token", accessToken, {
        path: "/",
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
      response.cookie("logged_in", "1", {
        path: "/",
        httpOnly: true,
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
      const user = await this.prisma.user.findFirst({
        where: {
          id: payload.sub,
          refreshTokens: {
            some: { id: payload.refreshTokenId, expiresAt: { gt: new Date() } },
          },
        },
      });
      if (!user) return null;
      assertEmailVerificationAccess(user);
      return user.id;
    } catch {
      return null;
    }
  }

  /**
   * A signed-in user proving a factor again, to change their email address,
   * password or 2FA, makes one more sign-in attempt: a stolen session must not
   * become a guessing oracle that the per-account lock never sees.
   */
  async countReauthentication(
    userId: string,
    check: () => Promise<boolean>,
  ): Promise<boolean> {
    const state = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        failedLoginAttempts: true,
        lastFailedLoginAt: true,
        lockedUntil: true,
      },
    });
    if (!state) return false;
    if (state.lockedUntil && state.lockedUntil > new Date())
      throw this.lockedLogin(state.lockedUntil);
    // Counted before it is checked, like a sign-in code: concurrent guesses
    // must not all read the same count and each get a check. Only those within
    // the limit are checked, the one that reaches it included.
    const reserved = await this.recordLoginFailure(state);
    if (reserved.blocked)
      throw this.lockedLogin(reserved.lockedUntil ?? new Date());
    if (await check()) {
      await this.refundAttempt(userId, reserved);
      return true;
    }
    if (reserved.lockedUntil) throw this.lockedLogin(reserved.lockedUntil);
    return false;
  }

  /**
   * A correct password gives back the attempt it reserved. The failure count
   * only restarts once the sign-in is complete: with 2FA on, after the code,
   * so that knowing the password does not buy fresh guesses at it.
   */
  private async passwordAccepted(
    user: User,
    reserved?: LoginReservation | null,
  ) {
    if (reserved) await this.refundAttempt(user.id, reserved);
    if (!user.totpVerified) await this.clearLoginFailures(user.id);
  }

  /** A proven attempt gives back what it reserved, and the lock if it set it. */
  private async refundAttempt(userId: string, reserved: LoginReservation) {
    await this.prisma.user.updateMany({
      where: { id: userId, failedLoginAttempts: { gt: 0 } },
      data: { failedLoginAttempts: { decrement: 1 } },
    });
    if (reserved.lockOwned && reserved.lockedUntil) {
      await this.prisma.user.updateMany({
        where: { id: userId, lockedUntil: reserved.lockedUntil },
        data: { lockedUntil: null },
      });
    }
  }

  /** Re-authentication only: sign-in checks its password on its own. */
  async verifyPassword(user: User, password: string) {
    return this.countReauthentication(user.id, () =>
      this.matchesPassword(user, password),
    );
  }

  private async matchesPassword(user: User, password: string) {
    if (!user.password && user.ldapDN && this.config.get("ldap.enabled")) {
      // The username can be edited: only the directory entry this account was
      // created from may vouch for it.
      const ldapUser = await this.ldapService.authenticateUser(
        user.username,
        password,
      );
      return ldapUser?.dn === user.ldapDN;
    }

    if (!user.password) return false;

    return argon.verify(user.password, password);
  }
}
