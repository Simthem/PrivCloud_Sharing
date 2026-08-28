import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import {
  EMAIL_VERIFICATION_TOKEN_TTL_HOURS,
  getEmailVerificationState,
} from "./emailVerification.util";

interface VerificationUser {
  id: string;
  email: string;
  emailVerificationRequiredAt: Date | null;
  emailVerifiedAt: Date | null;
  emailVerificationDeletionStartedAt: Date | null;
}

export interface ResendOutcome {
  /**
   * Whether this request passed the per-address cooldown. It reflects the
   * caller's own request history only, never whether the address is
   * registered, so it is safe to return to an anonymous client.
   */
  accepted: boolean;
  retryAfterSeconds: number;
}

// A slow relay can deliver messages minutes late and out of order, so several
// links stay usable at once instead of each new one revoking its predecessors.
const MAX_LIVE_TOKENS_PER_USER = 3;
const MAX_TRACKED_RESEND_ADDRESSES = 5000;

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly resendCooldownMs = 60 * 1000;
  // Keyed by a digest of the address so no plaintext e-mail is held in memory.
  private readonly lastResendRequest = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private emailService: EmailService,
  ) {}

  /**
   * An instance without SMTP can never deliver a verification link. Callers
   * that create accounts use this to exempt them instead of refusing them;
   * only an explicit request for a message is allowed to fail loudly.
   */
  isDeliveryAvailable(): boolean {
    return !!this.config.get("smtp.enabled");
  }

  assertDeliveryAvailable(): void {
    if (!this.isDeliveryAvailable()) {
      throw new ServiceUnavailableException(
        "Email verification is required but SMTP is not configured",
      );
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
  }

  async issueAndSend(user: VerificationUser): Promise<void> {
    if (
      !user.emailVerificationRequiredAt ||
      user.emailVerifiedAt ||
      user.emailVerificationDeletionStartedAt
    ) {
      return;
    }

    this.assertDeliveryAvailable();

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = this.hashToken(rawToken);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() +
        EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );

    // Never revoke the links still in flight: the recipient must be able to use
    // whichever message reaches the inbox first. Only expired tokens and the
    // oldest ones beyond the cap are dropped.
    const existing = await this.prisma.emailVerificationToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { tokenHash: true, expiresAt: true },
    });
    const live = existing.filter((token) => token.expiresAt > now);
    const revoked = [
      ...existing.filter((token) => token.expiresAt <= now),
      ...live.slice(MAX_LIVE_TOKENS_PER_USER - 1),
    ].map((token) => token.tokenHash);

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.deleteMany({
        where: { tokenHash: { in: revoked } },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          tokenHash,
          createdAt: now,
          expiresAt,
          email: user.email,
          userId: user.id,
        },
      }),
    ]);

    // The raw token exists only in memory and in the URL fragment. It is never
    // persisted or logged; only its SHA-256 digest is stored.
    await this.emailService.sendEmailVerificationEmail(user.email, rawToken);
  }

  /**
   * Applied to every requested address, registered or not, so the cooldown it
   * reports cannot be used to probe which accounts exist.
   */
  private consumeResendSlot(normalizedEmail: string): ResendOutcome {
    const now = Date.now();
    this.pruneResendRequests(now);

    const key = this.hashToken(normalizedEmail);
    const previous = this.lastResendRequest.get(key);
    if (previous !== undefined && now - previous < this.resendCooldownMs) {
      return {
        accepted: false,
        retryAfterSeconds: Math.ceil(
          (this.resendCooldownMs - (now - previous)) / 1000,
        ),
      };
    }

    this.lastResendRequest.set(key, now);
    return {
      accepted: true,
      retryAfterSeconds: Math.ceil(this.resendCooldownMs / 1000),
    };
  }

  private pruneResendRequests(now: number): void {
    if (this.lastResendRequest.size <= MAX_TRACKED_RESEND_ADDRESSES) return;

    for (const [key, requestedAt] of this.lastResendRequest) {
      if (now - requestedAt >= this.resendCooldownMs) {
        this.lastResendRequest.delete(key);
      }
    }
    // Under a flood of distinct addresses every entry can still be fresh; drop
    // the oldest ones so the map cannot grow without bound.
    for (const key of this.lastResendRequest.keys()) {
      if (this.lastResendRequest.size <= MAX_TRACKED_RESEND_ADDRESSES) break;
      this.lastResendRequest.delete(key);
    }
  }

  async resend(email: string): Promise<ResendOutcome> {
    // An instance that cannot send at all is a server configuration problem,
    // not an account-specific one: reporting it leaks nothing and stops the
    // caller from waiting for a message that will never be produced.
    this.assertDeliveryAvailable();

    const outcome = this.consumeResendSlot(email.trim().toLowerCase());
    if (!outcome.accepted) return outcome;

    const user = await this.prisma.user.findFirst({
      where: {
        email,
        emailVerificationRequiredAt: { not: null },
        emailVerifiedAt: null,
        emailVerificationDeletionStartedAt: null,
      },
      include: {
        emailVerificationTokens: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    // Keep the public response indistinguishable for unknown, legacy, verified
    // and throttled addresses to limit account enumeration and email bombing.
    if (!user) return outcome;

    const newest = user.emailVerificationTokens[0];
    if (
      newest &&
      Date.now() - newest.createdAt.getTime() < this.resendCooldownMs
    ) {
      // Backstop for the replicas that did not serve the previous request and
      // for the link issued at sign-up moments earlier.
      return outcome;
    }

    try {
      await this.issueAndSend(user);
    } catch (error) {
      this.logger.warn(
        `Could not resend an email-verification message: ${(error as Error).message}`,
      );
    }

    return outcome;
  }

  async verify(rawToken: string) {
    const tokenHash = this.hashToken(rawToken);
    const token = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    const now = new Date();

    if (
      !token ||
      token.expiresAt <= now ||
      token.email !== token.user.email ||
      !token.user.emailVerificationRequiredAt ||
      token.user.emailVerifiedAt ||
      token.user.emailVerificationDeletionStartedAt
    ) {
      if (token && token.expiresAt <= now) {
        await this.prisma.emailVerificationToken.deleteMany({
          where: { tokenHash },
        });
      }
      throw new BadRequestException("Verification link is invalid or expired");
    }

    const verifiedAt = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: {
          id: token.userId,
          email: token.email,
          emailVerificationRequiredAt: { not: null },
          emailVerifiedAt: null,
          emailVerificationDeletionStartedAt: null,
        },
        data: { emailVerifiedAt: verifiedAt },
      }),
      // Every sibling link becomes useless once the address is confirmed.
      this.prisma.emailVerificationToken.deleteMany({
        where: { userId: token.userId },
      }),
    ]);

    if (updated.count !== 1) {
      throw new BadRequestException("Verification link is invalid or expired");
    }

    return {
      verified: true,
      ...getEmailVerificationState(
        {
          ...token.user,
          emailVerifiedAt: verifiedAt,
        },
        verifiedAt,
      ),
    };
  }
}
