import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";

// Accounts with a linked OAuth provider may confirm 2FA changes, or the first
// password of an account without one, by signing in again with it. The intent
// is started from a signed-in session, because the provider's redirect back to
// the callback never carries the SameSite=Strict session cookie.
export const OAUTH_REAUTH_INTENT_TTL_MS = 10 * 60 * 1000;
export const OAUTH_REAUTH_PROOF_TTL_MS = 5 * 60 * 1000;
// An OIDC provider must have authenticated the user this recently.
export const OAUTH_REAUTH_MAX_AUTH_AGE_MS = 10 * 60 * 1000;
export const OAUTH_REAUTH_COOKIE = "reauth_confirmation";
// Only the auth routes ever receive the proof: 2FA changes, passkeys, the
// first password and step-up confirmations.
export const OAUTH_REAUTH_COOKIE_PATH = "/api/auth";
// A proof only confirms the change it was started for.
export type OAuthReauthPurpose = "TOTP" | "PASSWORD" | "EMAIL" | "STEP_UP";
const PURPOSES: readonly string[] = ["TOTP", "PASSWORD", "EMAIL", "STEP_UP"];

const hash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class OAuthReauthService {
  constructor(private prisma: PrismaService) {}

  private async issue(
    userId: string,
    provider: string,
    stage: "PENDING" | "VERIFIED",
    ttlMs: number,
    purpose: OAuthReauthPurpose,
  ) {
    const token = randomBytes(32).toString("base64url");
    await this.prisma.oAuthReauthToken.create({
      data: {
        tokenHash: hash(token),
        userId,
        provider,
        stage,
        purpose,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  /** Spend a token once. Unknown, expired, reused or foreign tokens: null. */
  private async consume(
    token: unknown,
    stage: "PENDING" | "VERIFIED",
    match: { userId?: string; provider?: string; purpose?: string },
  ) {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const row = await this.prisma.oAuthReauthToken.findUnique({
      where: { tokenHash: hash(token) },
    });
    if (
      !row ||
      row.stage !== stage ||
      (match.purpose && row.purpose !== match.purpose) ||
      row.usedAt ||
      row.expiresAt.getTime() <= Date.now() ||
      (match.userId && row.userId !== match.userId) ||
      (match.provider && row.provider !== match.provider)
    ) {
      return null;
    }
    const spent = await this.prisma.oAuthReauthToken.updateMany({
      where: { tokenHash: row.tokenHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    return spent.count === 1 ? row : null;
  }

  async startIntent(
    userId: string,
    provider: string,
    purpose: OAuthReauthPurpose = "TOTP",
  ) {
    // The table stays tiny: spent and expired rows go whenever one starts.
    await this.purge();
    return this.issue(
      userId,
      provider,
      "PENDING",
      OAUTH_REAUTH_INTENT_TTL_MS,
      purpose,
    );
  }

  /** The user and change the intent was started for, once. */
  async consumeIntent(token: unknown, provider: string) {
    const row = await this.consume(token, "PENDING", { provider });
    if (!row || !PURPOSES.includes(row.purpose)) return null;
    return { userId: row.userId, purpose: row.purpose as OAuthReauthPurpose };
  }

  issueProof(
    userId: string,
    provider: string,
    purpose: OAuthReauthPurpose = "TOTP",
  ) {
    return this.issue(
      userId,
      provider,
      "VERIFIED",
      OAUTH_REAUTH_PROOF_TTL_MS,
      purpose,
    );
  }

  /** Whether a proof is valid for this user, without spending it. */
  async hasProof(
    token: unknown,
    userId: string,
    purpose: OAuthReauthPurpose = "TOTP",
  ) {
    if (typeof token !== "string" || !TOKEN.test(token)) return false;
    const row = await this.prisma.oAuthReauthToken.findUnique({
      where: { tokenHash: hash(token) },
    });
    return (
      !!row &&
      row.stage === "VERIFIED" &&
      row.purpose === purpose &&
      !row.usedAt &&
      row.expiresAt.getTime() > Date.now() &&
      row.userId === userId
    );
  }

  async consumeProof(
    token: unknown,
    userId: string,
    purpose: OAuthReauthPurpose = "TOTP",
  ) {
    return !!(await this.consume(token, "VERIFIED", { userId, purpose }));
  }

  /** Expired and spent rows serve nothing. */
  async purge() {
    await this.prisma.oAuthReauthToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }],
      },
    });
  }
}
