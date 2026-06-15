import { Module } from "@nestjs/common";
import { PrismaModule } from "src/prisma/prisma.module";
import { PushModule } from "src/push/push.module";
import { TeamNotificationController } from "./teamNotification.controller";
import { TeamNotificationService } from "./teamNotification.service";

@Module({
  imports: [PrismaModule, PushModule],
  controllers: [TeamNotificationController],
  providers: [TeamNotificationService],
  exports: [TeamNotificationService],
})
export class TeamNotificationModule {}
