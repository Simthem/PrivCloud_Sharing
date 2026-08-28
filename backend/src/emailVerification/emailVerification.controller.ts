import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { ResendEmailVerificationDTO } from "./dto/resendEmailVerification.dto";
import { VerifyEmailDTO } from "./dto/verifyEmail.dto";
import {
  EmailVerificationService,
  ResendOutcome,
} from "./emailVerification.service";

@Controller("auth/email-verification")
export class EmailVerificationController {
  constructor(
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  @Post("verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: minutes(5) } })
  verify(@Body() dto: VerifyEmailDTO) {
    return this.emailVerificationService.verify(dto.token);
  }

  @Post("resend")
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  // The body reports the caller's own cooldown, which is identical for every
  // address; it never says whether a message was actually produced.
  resend(@Body() dto: ResendEmailVerificationDTO): Promise<ResendOutcome> {
    return this.emailVerificationService.resend(dto.email);
  }
}
