import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Request } from "express";
import { ConfigService } from "src/config/config.service";
import { AltchaService } from "./altcha.service";

@Injectable()
export class AltchaGuard implements CanActivate {
  private readonly logger = new Logger(AltchaGuard.name);

  constructor(
    private config: ConfigService,
    private altchaService: AltchaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.get("altcha.enabled")) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Skip captcha for authenticated users (guard placed after JwtGuard/CreateShareGuard).
    if ((request as any).user) {
      return true;
    }

    const captchaToken = request.body?.captchaToken;

    if (!captchaToken) {
      this.logger.warn("ALTCHA payload missing from request body");
      throw new BadRequestException("Captcha token is required");
    }

    await this.altchaService.verifyPayload(captchaToken);
    return true;
  }
}
