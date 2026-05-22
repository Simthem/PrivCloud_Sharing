import { Module } from "@nestjs/common";
import { SigningController } from "./signing.controller";
import { SigningService } from "./signing.service";
import { SigningOtpService } from "./signing-otp.service";
import { SigningDownloadService } from "./signing-download.service";
import { SigningE2EService } from "./signing-e2e.service";
import { PdfSigningService } from "./pdf-signing.service";
import { PrismaModule } from "src/prisma/prisma.module";
import { EmailModule } from "src/email/email.module";
import { FileModule } from "src/file/file.module";
import { ConfigModule } from "src/config/config.module";
@Module({
  imports: [PrismaModule, EmailModule, FileModule, ConfigModule],
  controllers: [SigningController],
  providers: [
    SigningService,
    SigningOtpService,
    SigningDownloadService,
    SigningE2EService,
    PdfSigningService,
  ],
  exports: [SigningService],
})
export class SigningModule {}
