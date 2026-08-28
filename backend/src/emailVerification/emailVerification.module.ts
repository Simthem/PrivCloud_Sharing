import { Module } from "@nestjs/common";
import { EmailModule } from "src/email/email.module";
import { EmailVerificationController } from "./emailVerification.controller";
import { EmailVerificationService } from "./emailVerification.service";

@Module({
  imports: [EmailModule],
  controllers: [EmailVerificationController],
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}

