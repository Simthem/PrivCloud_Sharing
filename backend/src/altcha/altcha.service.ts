import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";
import { randomUUID, createHmac } from "crypto";
import {
  createChallenge,
  randomInt,
  verifySolution,
  type Challenge,
  type Payload,
} from "altcha-lib";
import { deriveKey as derivePbkdf2Key } from "altcha-lib/algorithms/pbkdf2";
import { ConfigKey, ConfigService } from "src/config/config.service";

const DEFAULT_ALGORITHM = "PBKDF2/SHA-256";
const DEFAULT_COST = 5000;
const DEFAULT_EFFORT = 250;
const DEFAULT_EXPIRES_IN_SECONDS = 10 * 60;
const HMAC_KEY_SIGNATURE_CONTEXT = "privcloud-sharing:altcha:key-signature:v1";
const MAX_PAYLOAD_LENGTH = 20_000;

const SUPPORTED_ALGORITHMS = [
  "PBKDF2/SHA-256",
  "PBKDF2/SHA-384",
  "PBKDF2/SHA-512",
] as const;

type SupportedAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

@Injectable()
export class AltchaService {
  private readonly logger = new Logger(AltchaService.name);
  private readonly hmacKeySecretCache = new Map<string, string>();

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async createChallenge(): Promise<Challenge> {
    const algorithm = this.getAlgorithm();
    const cost = this.getNumber("altcha.cost", DEFAULT_COST, 1000, 250_000);
    const effort = this.getNumber("altcha.effort", DEFAULT_EFFORT, 1, 10_000);
    const hmacSignatureSecret = this.getHmacSignatureSecret();
    const hmacKeySignatureSecret =
      this.deriveHmacKeySecret(hmacSignatureSecret);
    const expiresInSeconds = this.getNumber(
      "altcha.expiresInSeconds",
      DEFAULT_EXPIRES_IN_SECONDS,
      60,
      3600,
    );
    const counter = this.config.get("altcha.randomEffort")
      ? randomInt(effort * 2, Math.max(1, Math.floor(effort / 2)))
      : effort;

    return createChallenge({
      algorithm,
      cost,
      counter,
      data: {
        challengeId: randomUUID(),
      },
      deriveKey: derivePbkdf2Key,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      hmacSignatureSecret,
      hmacKeySignatureSecret,
    });
  }

  async verifyPayload(payload: unknown): Promise<void> {
    if (typeof payload !== "string" || payload.length === 0) {
      throw new BadRequestException("Captcha token is required");
    }

    if (payload.length > MAX_PAYLOAD_LENGTH) {
      throw new BadRequestException("Captcha token is too large");
    }

    const parsedPayload = this.parsePayload(payload);
    const challengeId = this.getChallengeId(parsedPayload);
    const expiresAt = parsedPayload.challenge.parameters.expiresAt;
    const storeExpiresAt =
      typeof expiresAt === "number"
        ? expiresAt
        : Math.floor(Date.now() / 1000) + DEFAULT_EXPIRES_IN_SECONDS;

    try {
      const verification = await verifySolution({
        challenge: parsedPayload.challenge,
        deriveKey: derivePbkdf2Key,
        hmacSignatureSecret: this.getHmacSignatureSecret(),
        hmacKeySignatureSecret: this.deriveHmacKeySecret(
          this.getHmacSignatureSecret(),
        ),
        solution: parsedPayload.solution,
      });

      if (!verification.verified) {
        this.logger.warn(
          `ALTCHA verification failed: expired=${verification.expired}, invalidSignature=${verification.invalidSignature}, invalidSolution=${verification.invalidSolution}`,
        );
        throw new BadRequestException("Captcha verification failed");
      }

      this.logger.debug(
        `ALTCHA verification succeeded: challenge=${challengeId}, time=${verification.time}ms`,
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.warn("ALTCHA verification error");
      throw new BadRequestException("Captcha verification failed");
    }

    await this.spendChallenge(challengeId, storeExpiresAt);
  }

  /** Once per challenge, whichever backend instance receives it. */
  private async spendChallenge(challengeId: string, expiresAt: number) {
    await this.prisma.altchaUse.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    try {
      await this.prisma.altchaUse.create({
        data: { challengeId, expiresAt: new Date(expiresAt * 1000) },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        this.logger.warn(`ALTCHA replay attempt rejected: ${challengeId}`);
        throw new BadRequestException("Captcha verification failed");
      }
      throw error;
    }
  }

  private parsePayload(payload: string): Payload {
    try {
      const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
      const parsed = JSON.parse(
        Buffer.from(normalizedPayload, "base64").toString("utf8"),
      );

      if (!this.isPayload(parsed)) {
        throw new Error("Invalid ALTCHA payload shape");
      }

      const algorithm = parsed.challenge.parameters.algorithm;
      if (!this.isSupportedAlgorithm(algorithm)) {
        throw new Error(`Unsupported ALTCHA algorithm: ${algorithm}`);
      }

      return parsed;
    } catch {
      this.logger.warn("ALTCHA payload parsing failed");
      throw new BadRequestException("Captcha verification failed");
    }
  }

  private isPayload(value: unknown): value is Payload {
    const payload = value as Partial<Payload> | null;
    return (
      !!payload &&
      typeof payload === "object" &&
      !!payload.challenge &&
      typeof payload.challenge === "object" &&
      !!payload.challenge.parameters &&
      typeof payload.challenge.parameters === "object" &&
      typeof payload.challenge.parameters.nonce === "string" &&
      typeof payload.challenge.parameters.salt === "string" &&
      typeof payload.challenge.parameters.keyPrefix === "string" &&
      !!payload.solution &&
      typeof payload.solution === "object" &&
      typeof payload.solution.counter === "number" &&
      typeof payload.solution.derivedKey === "string"
    );
  }

  private getChallengeId(payload: Payload): string {
    const challengeId = payload.challenge.parameters.data?.challengeId;
    return typeof challengeId === "string"
      ? challengeId
      : payload.challenge.parameters.nonce;
  }

  private getAlgorithm(): SupportedAlgorithm {
    const algorithm = this.config.get("altcha.algorithm") || DEFAULT_ALGORITHM;

    if (this.isSupportedAlgorithm(algorithm)) {
      return algorithm;
    }

    this.logger.warn(
      `Unsupported ALTCHA algorithm configured (${algorithm}), falling back to ${DEFAULT_ALGORITHM}`,
    );
    return DEFAULT_ALGORITHM;
  }

  private isSupportedAlgorithm(value: unknown): value is SupportedAlgorithm {
    return (
      typeof value === "string" &&
      SUPPORTED_ALGORITHMS.includes(value as SupportedAlgorithm)
    );
  }

  private getNumber(
    key: ConfigKey,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.config.get(key));

    if (!Number.isFinite(value)) return fallback;

    return Math.min(max, Math.max(min, Math.floor(value)));
  }

  private getHmacSignatureSecret(): string {
    const configuredSecret = this.config.get("altcha.hmacKey");
    const fallbackSecret = this.config.get("internal.jwtSecret");
    const secret = configuredSecret || fallbackSecret;

    if (!secret || typeof secret !== "string") {
      throw new BadRequestException("Captcha verification unavailable");
    }

    return secret;
  }

  private deriveHmacKeySecret(masterSecret: string): string {
    const cached = this.hmacKeySecretCache.get(masterSecret);
    if (cached) return cached;

    const derived = createHmac("sha256", masterSecret)
      .update(HMAC_KEY_SIGNATURE_CONTEXT)
      .digest("hex");
    this.hmacKeySecretCache.set(masterSecret, derived);
    return derived;
  }
}
