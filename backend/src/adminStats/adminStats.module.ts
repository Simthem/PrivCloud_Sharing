import { Module } from "@nestjs/common";
import { AdminStatsController } from "./adminStats.controller";
import { AdminStatsService } from "./adminStats.service";

@Module({
  controllers: [AdminStatsController],
  providers: [AdminStatsService],
})
export class AdminStatsModule {}
