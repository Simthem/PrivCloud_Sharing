import { TeamFileRequestModule } from "src/teamFileRequest/team-file-request.module";
import { TeamExternalModule } from "src/teamExternal/team-external.module";
import { Module } from "@nestjs/common";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
import { PrismaModule } from "src/prisma/prisma.module";
import { EmailModule } from "src/email/email.module";
import { ConfigModule } from "src/config/config.module";
import { FileModule } from "src/file/file.module";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
import { TeamAuditService } from "./team-audit.service";
import { StepUpModule } from "src/auth/stepUp.module";
@Module({
  imports: [
    TeamFileRequestModule,
    PrismaModule,
    EmailModule,
    ConfigModule,
    FileModule,
    TeamNotificationModule,
    TeamExternalModule,
    StepUpModule,
  ],
  controllers: [TeamController],
  providers: [TeamService, TeamAuditService],
  exports: [TeamService, TeamAuditService],
})
export class TeamModule {}
