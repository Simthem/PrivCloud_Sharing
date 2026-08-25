import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { hours, minutes, Throttle } from "@nestjs/throttler";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { User } from "@prisma/client";
import { EnrollmentTokenService } from "./enrollment.service";
import { CreateEnrollmentTokenDTO, ConsumeEnrollmentTokenDTO } from "./dto/crypto.dto";

@Controller("crypto/enrollment")
export class EnrollmentTokenController {
  constructor(private enrollmentService: EnrollmentTokenService) {}

  /**
   * Create an enrollment token (for onboarding, team join, or device addition).
   */
  @Post("tokens")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: hours(1), limit: 20 } })
  async createToken(
    @GetUser() user: User,
    @Body() dto: CreateEnrollmentTokenDTO,
  ) {
    return this.enrollmentService.createToken(user.id, dto);
  }

  /**
   * Consume an enrollment token (one-time use).
   */
  @Post("consume")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: minutes(1), limit: 5 } })
  async consumeToken(
    @GetUser() user: User,
    @Body() dto: ConsumeEnrollmentTokenDTO,
  ) {
    return this.enrollmentService.consumeToken(user.id, dto);
  }

  /**
   * List my created enrollment tokens.
   */
  @Get("tokens")
  @UseGuards(JwtGuard)
  async listMyTokens(@GetUser() user: User) {
    return this.enrollmentService.listMyTokens(user.id);
  }

  /**
   * Revoke an enrollment token.
   */
  @Delete("tokens/:tokenId")
  @UseGuards(JwtGuard)
  async revokeToken(@GetUser() user: User, @Param("tokenId") tokenId: string) {
    return this.enrollmentService.revokeToken(tokenId, user.id);
  }
}
