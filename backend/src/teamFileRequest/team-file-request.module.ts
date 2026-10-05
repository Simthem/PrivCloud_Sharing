import { EmailModule } from "src/email/email.module";
import { ConfigModule } from "src/config/config.module";
import { Module } from "@nestjs/common";
import { PrismaModule } from "src/prisma/prisma.module";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
import { TeamFileRequestController } from "./team-file-request.controller";
import { TeamFileRequestService } from "./team-file-request.service";

@Module({
  imports: [EmailModule, ConfigModule, PrismaModule, TeamNotificationModule],
  controllers: [TeamFileRequestController],
  providers: [TeamFileRequestService],
})
export class TeamFileRequestModule {}
