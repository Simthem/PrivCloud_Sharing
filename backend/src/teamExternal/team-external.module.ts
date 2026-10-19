import { Module } from "@nestjs/common";
import { ConfigModule } from "src/config/config.module";
import { EmailModule } from "src/email/email.module";
import { FileModule } from "src/file/file.module";
import { PasskeyModule } from "src/passkey/passkey.module";
import { PrismaModule } from "src/prisma/prisma.module";
import { SigningModule } from "src/signing/signing.module";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
import { TeamExternalRevocationService } from "./team-external-revocation.service";
import {
  TeamExternalAdminController,
  TeamExternalContractorController,
  TeamExternalInvitationController,
} from "./team-external.controller";
import { TeamExternalAuditService } from "./team-external-audit.service";
import { TeamExternalService } from "./team-external.service";

@Module({
  imports: [
    ConfigModule,
    EmailModule,
    FileModule,
    PasskeyModule,
    PrismaModule,
    SigningModule,
    TeamNotificationModule,
  ],
  controllers: [
    TeamExternalAdminController,
    TeamExternalContractorController,
    TeamExternalInvitationController,
  ],
  providers: [
    TeamExternalAuditService,
    TeamExternalService,
    TeamExternalRevocationService,
  ],
  exports: [TeamExternalService, TeamExternalAuditService],
})
export class TeamExternalModule {}
