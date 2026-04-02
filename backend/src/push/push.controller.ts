import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { PushSubscriptionDto } from "./dto/pushSubscription.dto";
import { PushService } from "./push.service";

@Controller("push")
export class PushController {
  constructor(private pushService: PushService) {}

  @Post("subscribe")
  @UseGuards(JwtGuard)
  async subscribe(@GetUser() user: User, @Body() dto: PushSubscriptionDto) {
    await this.pushService.subscribe(
      user.id,
      dto.endpoint,
      dto.p256dh,
      dto.auth,
    );
  }

  @Delete("subscribe")
  @HttpCode(204)
  @UseGuards(JwtGuard)
  async unsubscribe(@GetUser() user: User, @Body() body: { endpoint: string }) {
    await this.pushService.unsubscribe(user.id, body.endpoint);
  }
}
