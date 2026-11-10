import { findUserIdByEmail } from "src/prisma/sealed-columns";
import { loadConfigKey } from "src/config/config-encryption";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { EmailService } from "src/email/email.service";
import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import {
  openAccountSecret,
  sealAccountSecret,
  verifiedEmailFold,
} from "../config/account-secrets";
import { OAuthUser, User } from "@prisma/client";
import { nanoid } from "nanoid";
import { AuthService } from "../auth/auth.service";
import { ConfigService } from "../config/config.service";
import { PrismaService } from "../prisma/prisma.service";
import { OAuthSignInDto } from "./dto/oauthSignIn.dto";
import { ErrorPageException } from "./exceptions/errorPage.exception";
import { OAuthProvider } from "./provider/oauthProvider.interface";

const OAUTH_LINK_AUDIENCE = "oauth-link";

@Injectable()
export class OAuthService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    @Inject(forwardRef(() => AuthService)) private auth: AuthService,
    @Inject("OAUTH_PLATFORMS") private platforms: string[],
    @Inject("OAUTH_PROVIDERS")
    private oAuthProviders: Record<string, OAuthProvider<unknown>>,
    private jwtService: JwtService,
    private email: EmailService,
  ) {}
  private readonly logger = new Logger(OAuthService.name);

  available(): string[] {
    return this.platforms.filter((platform) =>
      this.config.getOAuth(platform, "enabled"),
    );
  }

  availableProviders(): Record<string, OAuthProvider<unknown>> {
    return Object.fromEntries(
      Object.entries(this.oAuthProviders).filter(([providerName]) =>
        this.config.getOAuth(providerName, "enabled"),
      ),
    );
  }

  /** The account, when it is an administrator's. */
  findAdministrator(userId: string) {
    return this.prisma.user.findFirst({ where: { id: userId, isAdmin: true } });
  }

  async status(user: User) {
    const oauthUsers = await this.prisma.oAuthUser.findMany({
      select: {
        provider: true,
        providerUsername: true,
        userId: true,
      },
      where: {
        userId: user.id,
      },
    });
    return Object.fromEntries(
      oauthUsers.map((u) => [
        u.provider,
        {
          provider: u.provider,
          providerUsername: openAccountSecret(
            user.id,
            "providerUsername",
            u.providerUsername,
          ),
        },
      ]),
    );
  }

  async signIn(user: OAuthSignInDto, ip: string) {
    const oauthUser = await this.prisma.oAuthUser.findFirst({
      where: {
        provider: user.provider,
        providerUserId: user.providerId,
      },
    });
    if (oauthUser) {
      await this.rememberVerifiedEmail(oauthUser, user.email);
      await this.updateIsAdmin(oauthUser.userId, user.isAdmin);
      const updatedUser = await this.prisma.user.findFirst({
        where: {
          id: oauthUser.userId,
        },
      });
      this.logger.log(`Successful OAuth login for user ${oauthUser.userId}`);
      return this.auth.generateToken(updatedUser, { idToken: user.idToken });
    }

    const owner = await this.findAccountByAddress(
      user.email ?? user.unverifiedEmail,
    );
    if (owner) return this.linkToExistingAccount(owner, user);

    return this.signUp(user, ip);
  }

  async link(
    userId: string,
    provider: string,
    providerUserId: string,
    providerUsername: string,
    verifiedEmail?: string,
  ) {
    const oauthUser = await this.prisma.oAuthUser.findFirst({
      where: {
        provider,
        providerUserId,
      },
    });
    if (oauthUser) {
      throw new ErrorPageException("already_linked", "/", [
        `provider_${provider}`,
      ]);
    }

    await this.prisma.oAuthUser.create({
      data: {
        userId,
        provider,
        providerUsername: sealAccountSecret(
          userId,
          "providerUsername",
          providerUsername,
        ),
        verifiedEmail: this.storedEmail(userId, verifiedEmail),
        verifiedEmailFold: this.foldOf(verifiedEmail),
        providerUserId,
      },
    });
  }

  private storedEmail(userId: string, email?: string) {
    return email
      ? sealAccountSecret(userId, "verifiedEmail", email.toLowerCase())
      : null;
  }

  private foldOf(email?: string | null) {
    return email ? verifiedEmailFold(email) : null;
  }

  private async rememberVerifiedEmail(link: OAuthUser, email?: string) {
    const known =
      link.verifiedEmail &&
      openAccountSecret(link.userId, "verifiedEmail", link.verifiedEmail);
    if (
      (known ?? undefined) === email?.toLowerCase() &&
      link.verifiedEmailFold === this.foldOf(email)
    ) {
      return;
    }
    await this.prisma.oAuthUser.update({
      where: { id: link.id },
      data: {
        verifiedEmail: this.storedEmail(link.userId, email),
        verifiedEmailFold: this.foldOf(email),
      },
    });
  }

  onModuleInit() {
    void this.recoverVerifiedEmails()
      .then(() => this.refreshVerifiedEmailFolds())
      .catch(() =>
        this.logger.warn("Linked provider addresses could not be indexed"),
      );
  }

  /**
   * Links made before the address was recorded get it from the ID token their
   * provider issued at the account's last sign-in, kept with its session.
   */
  async recoverVerifiedEmails() {
    const links = await this.prisma.oAuthUser.findMany({
      where: { verifiedEmail: null },
      select: { id: true, userId: true, provider: true, providerUserId: true },
    });
    for (const link of links) {
      const sessions = await this.prisma.refreshToken.findMany({
        where: { userId: link.userId, oauthIDToken: { not: null } },
        select: { userId: true, oauthIDToken: true },
        orderBy: { createdAt: "desc" },
      });
      const email = sessions
        .map(({ oauthIDToken }) => vouchedEmail(link, oauthIDToken))
        .find(Boolean);
      if (!email) continue;
      await this.prisma.oAuthUser.updateMany({
        where: { id: link.id, verifiedEmail: null },
        data: {
          verifiedEmail: this.storedEmail(link.userId, email),
          verifiedEmailFold: this.foldOf(email),
        },
      });
    }
  }

  /** Rows written by an older image have no lookup form, or a stale one. */
  async refreshVerifiedEmailFolds() {
    let after: string | undefined;
    for (;;) {
      const links = await this.prisma.oAuthUser.findMany({
        where: {
          verifiedEmail: { not: null },
          ...(after ? { id: { gt: after } } : {}),
        },
        select: {
          id: true,
          userId: true,
          verifiedEmail: true,
          verifiedEmailFold: true,
        },
        orderBy: { id: "asc" },
        take: 500,
      });
      if (links.length === 0) return;
      for (const link of links) {
        const fold = this.foldOf(link.verifiedEmail);
        if (fold === link.verifiedEmailFold) continue;
        await this.prisma.oAuthUser.updateMany({
          where: { id: link.id, verifiedEmailFold: link.verifiedEmailFold },
          data: { verifiedEmailFold: fold },
        });
      }
      after = links[links.length - 1].id;
    }
  }

  /** Whether this account has this provider linked (to that identity). */
  async isLinked(userId: string, provider: string, providerUserId?: string) {
    const count = await this.prisma.oAuthUser.count({
      where: {
        userId,
        provider,
        ...(providerUserId !== undefined && { providerUserId }),
      },
    });
    return count > 0;
  }

  async disconnectProvider(user: User, provider: string) {
    const oauthUser = await this.prisma.oAuthUser.findFirst({
      where: {
        userId: user.id,
        provider,
      },
    });
    if (oauthUser) {
      await this.prisma.oAuthUser.delete({
        where: {
          id: oauthUser.id,
        },
      });
    } else {
      throw new ErrorPageException("not_linked", "/", [provider]);
    }
  }

  private async getAvailableUsername(preferredUsername: string) {
    // Only keep letters, numbers, dots, and underscores. Truncate to 20 characters.
    const clean = (value: string) =>
      value
        .replace(/[^a-zA-Z0-9._]/g, "")
        .substring(0, 20)
        .replace(/^[._]+|[._]+$/g, "");
    const localPart = clean(preferredUsername.split("@")[0]);
    let username = localPart.length >= 3 ? localPart : clean(preferredUsername);
    while (true) {
      const user = await this.prisma.user.findFirst({
        where: {
          username: username,
        },
      });
      if (user) {
        username = username + "_" + nanoid(10).replaceAll("-", "");
      } else {
        return username;
      }
    }
  }

  /** The account already using this address, as its own or through a link. */
  private async findAccountByAddress(address?: string) {
    if (!address) return null;
    const id = await findUserIdByEmail(this.prisma, address, loadConfigKey());
    const account = id
      ? await this.prisma.user.findFirst({ where: { id } })
      : null;
    if (account) return { account, throughLink: false };

    const links = await this.prisma.oAuthUser.findMany({
      where: { verifiedEmailFold: this.foldOf(address) },
      include: { user: true },
    });
    const match = links.find(
      (link) =>
        link.verifiedEmail &&
        openAccountSecret(
          link.userId,
          "verifiedEmail",
          link.verifiedEmail,
        ).toLowerCase() === address.toLowerCase(),
    );
    return match ? { account: match.user, throughLink: true } : null;
  }

  /**
   * Joins a provider identity to the account holding its address: at once
   * when the provider vouches for an address the account has proven, after a
   * mailed confirmation otherwise. Administrators and 2FA accounts keep their
   * own confirmation from the account page.
   */
  private async linkToExistingAccount(
    { account, throughLink }: { account: User; throughLink: boolean },
    user: OAuthSignInDto,
  ) {
    const refused = new ErrorPageException("account_exists", "/auth/signIn", [
      `provider_${user.provider}`,
    ]);
    if (account.isAdmin || account.totpVerified) throw refused;

    if (user.email && (throughLink || account.emailVerifiedAt)) {
      await this.link(
        account.id,
        user.provider,
        user.providerId.toString(),
        user.providerUsername,
        user.email,
      );
      this.logger.log(`Linked ${user.provider} to user ${account.id}`);
      return this.auth.generateToken(account, { idToken: user.idToken });
    }

    if (!this.config.get("smtp.enabled")) throw refused;
    await this.mailLinkConfirmation(account, user);
    throw new ErrorPageException("link_email_sent", "/auth/signIn", [
      `provider_${user.provider}`,
    ]);
  }

  private async mailLinkConfirmation(account: User, user: OAuthSignInDto) {
    const token = this.jwtService.sign(
      {
        sub: account.id,
        provider: user.provider,
        providerUserId: user.providerId.toString(),
        providerUsername: user.providerUsername,
      },
      {
        audience: OAUTH_LINK_AUDIENCE,
        expiresIn: "30m",
        secret: this.config.get("internal.jwtSecret"),
      },
    );
    await this.email.sendOAuthLinkEmail(account.email, user.provider, token);
  }

  async confirmMailedLink(token: string) {
    let claims: {
      sub: string;
      provider: string;
      providerUserId: string;
      providerUsername: string;
    };
    try {
      claims = this.jwtService.verify(token, {
        audience: OAUTH_LINK_AUDIENCE,
        secret: this.config.get("internal.jwtSecret"),
      });
    } catch {
      throw new BadRequestException("This confirmation link is not valid");
    }
    if (await this.isLinked(claims.sub, claims.provider, claims.providerUserId))
      return;
    await this.link(
      claims.sub,
      claims.provider,
      claims.providerUserId,
      claims.providerUsername,
    );
  }

  private async signUp(user: OAuthSignInDto, ip: string) {
    // register
    if (!this.config.get("oauth.allowRegistration")) {
      throw new ErrorPageException("no_user", "/auth/signIn", [
        `provider_${user.provider}`,
      ]);
    }

    const email = user.email ?? user.unverifiedEmail;
    if (!email) {
      throw new ErrorPageException("no_email", "/auth/signIn", [
        `provider_${user.provider}`,
      ]);
    }

    const result = await this.auth.signUp(
      {
        email,
        username: await this.getAvailableUsername(user.providerUsername),
        password: null,
      },
      ip,
      user.isAdmin,
      Boolean(user.email),
      !user.email,
    );

    await this.prisma.oAuthUser.create({
      data: {
        provider: user.provider,
        providerUserId: user.providerId.toString(),
        providerUsername: sealAccountSecret(
          result.user.id,
          "providerUsername",
          user.providerUsername,
        ),
        verifiedEmail: this.storedEmail(result.user.id, user.email),
        verifiedEmailFold: this.foldOf(user.email),
        userId: result.user.id,
      },
    });

    return result;
  }

  private async updateIsAdmin(userId: string, isAdmin?: boolean) {
    if (isAdmin === undefined) return;
    await this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        isAdmin,
      },
    });
  }
}

/** The address an ID token of this link vouches for, as sign-in trusts it. */
export function vouchedEmail(
  link: { provider: string; providerUserId: string },
  stored: string | null,
) {
  if (!stored?.startsWith(`${link.provider}:`)) return undefined;
  let claims: Record<string, unknown>;
  try {
    const payload = stored.slice(link.provider.length + 1).split(".")[1];
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (claims.sub !== link.providerUserId || typeof claims.email !== "string") {
    return undefined;
  }
  const trusted =
    link.provider === "microsoft"
      ? [true, "true", 1, "1"].includes(claims.xms_edov as never)
      : claims.email_verified === true;
  return trusted ? claims.email.toLowerCase() : undefined;
}
