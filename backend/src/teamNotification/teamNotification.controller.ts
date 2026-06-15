import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { User } from "@prisma/client";
import { TeamNotificationService } from "./teamNotification.service";

const NO_STORE_HEADERS = {
  cacheControl: "no-store, no-cache, must-revalidate, proxy-revalidate",
  pragma: "no-cache",
  expires: "0",
};

@Controller("team-notifications")
export class TeamNotificationController {
  constructor(private notificationService: TeamNotificationService) {}

  /**
   * Deprecated SSE endpoint stub. Stale browser clients may still request this
   * after the switch to Web Push + polling. Returns 204 so they stop retrying
   * without flooding the logs with 404 errors.
   */
  @Get("events")
  @HttpCode(204)
  sseStub(@Res() res: Response) {
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  }

  /**
   * Get team notifications for the current user.
   * Supports filtering by team and read/unread status.
   */
  @Get()
  @UseGuards(JwtGuard)
  @Header("Cache-Control", NO_STORE_HEADERS.cacheControl)
  @Header("Pragma", NO_STORE_HEADERS.pragma)
  @Header("Expires", NO_STORE_HEADERS.expires)
  async getNotifications(
    @GetUser() user: User,
    @Query("teamId") teamId?: string,
    @Query("unreadOnly") unreadOnly?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.notificationService.getNotifications(user.id, {
      teamId,
      unreadOnly: unreadOnly === "true",
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Get unread count (for notification badge).
   */
  @Get("unread-count")
  @UseGuards(JwtGuard)
  @Header("Cache-Control", NO_STORE_HEADERS.cacheControl)
  @Header("Pragma", NO_STORE_HEADERS.pragma)
  @Header("Expires", NO_STORE_HEADERS.expires)
  async getUnreadCount(
    @GetUser() user: User,
    @Query("teamId") teamId?: string,
  ) {
    const count = await this.notificationService.getUnreadCount(user.id, teamId);
    return { count };
  }

  /**
   * Mark a single notification as read.
   */
  @Patch(":notificationId/read")
  @UseGuards(JwtGuard)
  async markAsRead(
    @GetUser() user: User,
    @Param("notificationId") notificationId: string,
  ) {
    return this.notificationService.markAsRead(notificationId, user.id);
  }

  /**
   * Mark all notifications as read (optionally scoped to a team).
   */
  @Post("mark-all-read")
  @UseGuards(JwtGuard)
  async markAllAsRead(
    @GetUser() user: User,
    @Query("teamId") teamId?: string,
  ) {
    return this.notificationService.markAllAsRead(user.id, teamId);
  }

  /**
   * Delete all notifications for the current user (optionally scoped to a team).
   */
  @Delete()
  @UseGuards(JwtGuard)
  async deleteAll(
    @GetUser() user: User,
    @Query("teamId") teamId?: string,
  ) {
    return this.notificationService.deleteAll(user.id, teamId);
  }
}
