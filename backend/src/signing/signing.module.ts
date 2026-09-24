import { Module } from "@nestjs/common";
import { SigningController } from "./signing.controller";
import { SigningService } from "./signing.service";
import { SigningDownloadService } from "./signing-download.service";
import { SigningE2EService } from "./signing-e2e.service";
import { PdfSigningService } from "./pdf-signing.service";
import { TrustedListMonitorService } from "./trusted-list-monitor.service";
import { PrismaModule } from "src/prisma/prisma.module";
import { EmailModule } from "src/email/email.module";
import { FileModule } from "src/file/file.module";
import { ConfigModule } from "src/config/config.module";
import { SigningWebAuthnService } from "./signing-webauthn.service";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
import { SigningEvidenceService } from "./signing-evidence.service";

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    FileModule,
    ConfigModule,
    TeamNotificationModule,
  ],
  controllers: [SigningController],
  providers: [
    SigningService,
    SigningDownloadService,
    SigningE2EService,
    SigningWebAuthnService,
    SigningEvidenceService,
    PdfSigningService,
    TrustedListMonitorService,
  ],
  exports: [SigningService, TrustedListMonitorService],
})
export class SigningModule {}
