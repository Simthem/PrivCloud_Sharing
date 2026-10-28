import { forwardRef, Module } from "@nestjs/common";
import { EmailModule } from "src/email/email.module";
import { EmailVerificationModule } from "src/emailVerification/emailVerification.module";
import { UserController } from "./user.controller";
import { UserSevice } from "./user.service";
import { FileModule } from "src/file/file.module";
import { AuthModule } from "src/auth/auth.module";
import { StepUpModule } from "src/auth/stepUp.module";

@Module({
  imports: [
    EmailModule,
    EmailVerificationModule,
    FileModule,
    forwardRef(() => AuthModule),
    StepUpModule,
  ],
  providers: [UserSevice],
  controllers: [UserController],
  exports: [UserSevice],
})
export class UserModule {}
