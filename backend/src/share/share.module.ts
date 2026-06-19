import { forwardRef, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AltchaModule } from "src/altcha/altcha.module";
import { BridgeUploadModule } from "src/bridgeUpload/bridge-upload.module";
import { ClamScanModule } from "src/clamscan/clamscan.module";
import { EmailModule } from "src/email/email.module";
import { FileModule } from "src/file/file.module";
import { PushModule } from "src/push/push.module";
import { ReverseShareModule } from "src/reverseShare/reverseShare.module";
import { ShareController } from "./share.controller";
import { ShareService } from "./share.service";
import { TeamShareAccessService } from "./team-share-access.service";

@Module({
  imports: [
    JwtModule.register({}),
    AltchaModule,
    BridgeUploadModule,
    EmailModule,
    forwardRef(() => ClamScanModule),
    ReverseShareModule,
    forwardRef(() => FileModule),
    PushModule,
  ],
  controllers: [ShareController],
  providers: [ShareService, TeamShareAccessService],
  exports: [ShareService, TeamShareAccessService],
})
export class ShareModule {}
