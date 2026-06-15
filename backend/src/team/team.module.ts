import { Module } from "@nestjs/common";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
import { PrismaModule } from "src/prisma/prisma.module";
import { EmailModule } from "src/email/email.module";
import { ConfigModule } from "src/config/config.module";
import { FileModule } from "src/file/file.module";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
@Module({
  imports: [PrismaModule, EmailModule, ConfigModule, FileModule, TeamNotificationModule],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
