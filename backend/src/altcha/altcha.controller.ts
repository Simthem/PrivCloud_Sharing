import { Controller, Get, Header } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AltchaService } from "./altcha.service";

@Controller("altcha")
export class AltchaController {
  constructor(private altchaService: AltchaService) {}

  @Get("challenge")
  @Header("Cache-Control", "no-store")
  @Throttle({
    default: {
      limit: 60,
      ttl: 60,
    },
  })
  async challenge() {
    return this.altchaService.createChallenge();
  }
}
