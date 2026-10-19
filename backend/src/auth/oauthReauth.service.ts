import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";

// Accounts with a linked OAuth provider may confirm 2FA changes by signing in
// again with it instead of a password. The intent is started from a signed-in
// session, because the provider's redirect back to the callback never carries
// the SameSite=Strict session cookie.
export const OAUTH_REAUTH_INTENT_TTL_MS = 10 * 60 * 1000;
export const OAUTH_REAUTH_PROOF_TTL_MS = 5 * 60 * 1000;
// An OIDC provider must have authenticated the user this recently.
export const OAUTH_REAUTH_MAX_AUTH_AGE_MS = 10 * 60 * 1000;
export const OAUTH_REAUTH_COOKIE = "reauth_confirmation";
// Only the auth routes ever receive the proof: 2FA changes and passkeys.
export const OAUTH_REAUTH_COOKIE_PATH = "/api/auth";
export const OAUTH_REAUTH_PURPOSE = "TOTP";

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
  ) {
    const token = randomBytes(32).toString("base64url");
    await this.prisma.oAuthReauthToken.create({
      data: {
        tokenHash: hash(token),
        userId,
        provider,
        stage,
        purpose: OAUTH_REAUTH_PURPOSE,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  /** Spend a token once. Unknown, expired, reused or foreign tokens: null. */
  private async consume(
    token: unknown,
    stage: "PENDING" | "VERIFIED",
    match: { userId?: string; provider?: string },
  ) {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const row = await this.prisma.oAuthReauthToken.findUnique({
      where: { tokenHash: hash(token) },
    });
    if (
      !row ||
      row.stage !== stage ||
      row.purpose !== OAUTH_REAUTH_PURPOSE ||
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

  async startIntent(userId: string, provider: string) {
    // The table stays tiny: spent and expired rows go whenever one starts.
    await this.purge();
    return this.issue(userId, provider, "PENDING", OAUTH_REAUTH_INTENT_TTL_MS);
  }

  /** The user the intent was started for, once. */
  async consumeIntent(token: unknown, provider: string) {
    const row = await this.consume(token, "PENDING", { provider });
    return row?.userId ?? null;
  }

  issueProof(userId: string, provider: string) {
    return this.issue(userId, provider, "VERIFIED", OAUTH_REAUTH_PROOF_TTL_MS);
  }

  /** Whether a proof is valid for this user, without spending it. */
  async hasProof(token: unknown, userId: string) {
    if (typeof token !== "string" || !TOKEN.test(token)) return false;
    const row = await this.prisma.oAuthReauthToken.findUnique({
      where: { tokenHash: hash(token) },
    });
    return (
      !!row &&
      row.stage === "VERIFIED" &&
      row.purpose === OAUTH_REAUTH_PURPOSE &&
      !row.usedAt &&
      row.expiresAt.getTime() > Date.now() &&
      row.userId === userId
    );
  }

  async consumeProof(token: unknown, userId: string) {
    return !!(await this.consume(token, "VERIFIED", { userId }));
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
