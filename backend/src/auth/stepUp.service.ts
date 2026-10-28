import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { Request } from "express";
import { PrismaService } from "src/prisma/prisma.service";

// A stolen session must not be enough to plant a lasting foothold: another
// administrator, someone else's credentials, a weaker sign-in policy, a
// passkey that signs in and signs documents. Those operations first ask the
// user to prove their identity again, for that operation alone.
export const STEP_UP_COOKIE = "step_up";
export const STEP_UP_COOKIE_PATH = "/api";
export const STEP_UP_TTL_MS = 2 * 60 * 1000;

// "user.update:<id>", "config.update"...: an operation and its target.
const SCOPE = /^[a-z][a-z.]{2,48}(?::[A-Za-z0-9_-]{1,64})?$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type StepUpMethod = "password" | "oauth" | "passkey";

const hash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const isStepUpScope = (scope: unknown): scope is string =>
  typeof scope === "string" && SCOPE.test(scope);

@Injectable()
export class StepUpService {
  private readonly logger = new Logger(StepUpService.name);

  constructor(private prisma: PrismaService) {}

  /** Records a confirmed identity for one operation, and its cookie value. */
  async issue(user: User, scope: string, method: StepUpMethod) {
    const grant = await this.record(user, scope, method, STEP_UP_TTL_MS);
    this.logger.log(
      `User ${user.id} confirmed their identity (${method}) for ${scope}`,
    );
    return grant;
  }

  /**
   * Carries a spent confirmation across a redirect the step-up cookie does
   * not follow, such as a provider sending the browser back to the callback.
   */
  async handOver(user: User, scope: string, ttlMs: number) {
    return (await this.record(user, scope, "handover", ttlMs)).value;
  }

  private async record(
    user: User,
    scope: string,
    method: StepUpMethod | "handover",
    ttlMs: number,
  ) {
    if (!isStepUpScope(scope)) {
      throw new ForbiddenException("Unknown operation");
    }
    await this.prisma.stepUpGrant.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }],
      },
    });
    const value = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.stepUpGrant.create({
      data: {
        tokenHash: hash(value),
        userId: user.id,
        scope,
        method,
        expiresAt,
      },
    });
    return { value, expiresAt };
  }

  /**
   * Any signed-in user may confirm the enrolment of a signing passkey on a
   * request assigned to them. Every other operation is an administrator's.
   */
  assertMayConfirm(user: User, scope: string) {
    if (!user.isAdmin && !scope.startsWith("signing.passkey.enroll:")) {
      throw new ForbiddenException("Unknown operation");
    }
  }

  // The factor checks already count a failure towards the sign-in lock. This
  // leaves a trace of which operation it was for.
  recordRefusal(user: User, scope: string) {
    this.logger.warn(
      `User ${user.id} failed to confirm their identity for ${scope}`,
    );
  }

  /**
   * Spends the confirmation this browser holds for exactly this operation, or
   * refuses with the scope the client has to confirm. Two requests racing on
   * one confirmation cannot both spend it.
   */
  async consume(request: Request, user: User, scope: string) {
    const value: unknown = request.cookies?.[STEP_UP_COOKIE];
    if (await this.spend(user.id, scope, value)) return;
    throw new ForbiddenException({
      statusCode: 403,
      message: "Confirm your identity to continue",
      error: "step_up_required",
      scope,
    });
  }

  /** Spends one confirmation of this user for exactly this operation. */
  async spend(userId: string, scope: string, value: unknown) {
    if (typeof value !== "string" || !TOKEN.test(value)) return false;
    const spent = await this.prisma.stepUpGrant.updateMany({
      where: {
        tokenHash: hash(value),
        userId,
        scope,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    return spent.count === 1;
  }
}
