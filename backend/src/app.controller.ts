import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { PrismaService } from "./prisma/prisma.service";

@Controller("/")
export class AppController {
  constructor(private prismaService: PrismaService) {}

  @Get("health")
  async health(@Res({ passthrough: true }) res: Response) {
    try {
      await this.prismaService.config.findMany();
      return "OK";
    } catch {
      res.statusCode = 500;
      return "ERROR";
    }
  }

  /**
   * Bandwidth probe -- the upload client sends a small body and measures the
   * round-trip time to estimate network throughput.  Returns 204 (no body)
   * so the measurement is not distorted by response latency.
   */
  @Post("probe")
  @HttpCode(204)
  probe() {
    return;
  }
}
