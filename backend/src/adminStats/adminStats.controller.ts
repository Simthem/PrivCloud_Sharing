import { Controller, Get, Header, Query, UseGuards } from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { AdminStatsService } from "./adminStats.service";
import { normalizeMonths } from "./usage-series.util";

@Controller("admin/stats")
export class AdminStatsController {
  constructor(private adminStats: AdminStatsService) {}

  /**
   * Platform-wide usage over time. Reserved to the instance administrator: the
   * series aggregates every account, so it is never scoped to the caller.
   */
  @Get("usage")
  @Header("Cache-Control", "private, no-store")
  // Building the series walks the whole file inventory. The global throttler
  // is far too permissive for that, and an administrator session should never
  // be a way to put the database under load.
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  @UseGuards(JwtGuard, AdministratorGuard)
  async usage(@Query("months") months?: string) {
    return this.adminStats.getUsageSeries(normalizeMonths(months));
  }
}
