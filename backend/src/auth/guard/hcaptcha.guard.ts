import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Request } from "express";
import { ConfigService } from "src/config/config.service";

interface HCaptchaResponse {
  success: boolean;
  "challenge_ts"?: string;
  hostname?: string;
  "error-codes"?: string[];
}

/**
 * HCaptchaGuard verifies hCaptcha tokens on protected routes.
 *
 * When hcaptcha.enabled is false, the guard passes through silently.
 * When the request already has an authenticated user (request.user),
 * the guard passes through — captcha is only for anonymous requests.
 * When enabled, it expects a `captchaToken` field in the request body
 * and validates it against the hCaptcha siteverify API.
 */
@Injectable()
export class HCaptchaGuard implements CanActivate {
  private readonly logger = new Logger(HCaptchaGuard.name);

  constructor(private config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.get("hcaptcha.enabled")) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Skip captcha for authenticated users (guard placed after JwtGuard/CreateShareGuard)
    if ((request as any).user) {
      return true;
    }

    const captchaToken = request.body?.captchaToken;

    if (!captchaToken) {
      this.logger.warn("Captcha token missing from request body");
      throw new BadRequestException("Captcha token is required");
    }

    const secretKey = this.config.get("hcaptcha.secretKey");
    if (!secretKey) {
      this.logger.warn(
        "hCaptcha is enabled but no secret key is configured — skipping verification",
      );
      return true;
    }

    const siteKey = this.config.get("hcaptcha.siteKey");

    try {
      const params = new URLSearchParams({
        secret: secretKey,
        response: captchaToken,
      });
      if (siteKey) {
        params.append("sitekey", siteKey);
      }

      const response = await fetch("https://api.hcaptcha.com/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });

      const data = (await response.json()) as HCaptchaResponse;

      if (!data.success) {
        this.logger.warn(
          `hCaptcha verification failed — error-codes: ${JSON.stringify(data["error-codes"] || [])}, hostname: ${data.hostname || "N/A"}`,
        );
        throw new BadRequestException("Captcha verification failed");
      }

      this.logger.debug(
        `hCaptcha verification succeeded — hostname: ${data.hostname}, ts: ${data["challenge_ts"]}`,
      );
      return true;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(
        `hCaptcha siteverify request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException("Captcha verification failed");
    }
  }
}
