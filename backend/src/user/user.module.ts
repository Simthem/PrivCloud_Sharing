import { forwardRef, Module } from "@nestjs/common";
import { EmailModule } from "src/email/email.module";
import { EmailVerificationModule } from "src/emailVerification/emailVerification.module";
import { UserController } from "./user.controller";
import { UserSevice } from "./user.service";
import { FileModule } from "src/file/file.module";
import { AuthModule } from "src/auth/auth.module";

@Module({
  imports: [
    EmailModule,
    EmailVerificationModule,
    FileModule,
    forwardRef(() => AuthModule),
  ],
  providers: [UserSevice],
  controllers: [UserController],
  exports: [UserSevice],
})
export class UserModule {}
