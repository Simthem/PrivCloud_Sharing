import { Module } from "@nestjs/common";
import { PrismaModule } from "src/prisma/prisma.module";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
import { EmailModule } from "src/email/email.module";
import { CryptoIdentityController } from "./identity.controller";
import { CryptoIdentityService } from "./identity.service";
import { AccessGrantController } from "./grant.controller";
import { AccessGrantService } from "./grant.service";
import { EnrollmentTokenController } from "./enrollment.controller";
import { EnrollmentTokenService } from "./enrollment.service";

@Module({
  imports: [PrismaModule, TeamNotificationModule, EmailModule],
  controllers: [
    CryptoIdentityController,
    AccessGrantController,
    EnrollmentTokenController,
  ],
  providers: [CryptoIdentityService, AccessGrantService, EnrollmentTokenService],
  exports: [CryptoIdentityService, AccessGrantService, EnrollmentTokenService],
})
export class CryptoModule {}
