import { Module } from "@nestjs/common";
import { SigningController } from "./signing.controller";
import { SigningService } from "./signing.service";
import { SigningDownloadService } from "./signing-download.service";
import { SigningE2EService } from "./signing-e2e.service";
import { PdfSigningService } from "./pdf-signing.service";
import { PrismaModule } from "src/prisma/prisma.module";
import { EmailModule } from "src/email/email.module";
import { FileModule } from "src/file/file.module";
import { ConfigModule } from "src/config/config.module";
import { SigningWebAuthnService } from "./signing-webauthn.service";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";

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
    PdfSigningService,
  ],
  exports: [SigningService],
})
export class SigningModule {}
