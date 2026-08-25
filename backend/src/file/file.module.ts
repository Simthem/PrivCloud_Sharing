import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { DownloadNotificationModule } from "src/downloadNotification/downloadNotification.module";
import { BridgeUploadModule } from "src/bridgeUpload/bridge-upload.module";
import { ReverseShareModule } from "src/reverseShare/reverseShare.module";
import { ShareModule } from "src/share/share.module";
import { TeamNotificationModule } from "src/teamNotification/teamNotification.module";
import { FileController } from "./file.controller";
import { FileService } from "./file.service";
import { LocalFileService } from "./local.service";
import { S3FileService } from "./s3.service";

@Module({
  imports: [
    JwtModule.register({}),
    BridgeUploadModule,
    ReverseShareModule,
    ShareModule,
    DownloadNotificationModule,
    TeamNotificationModule,
  ],
  controllers: [FileController],
  providers: [FileService, LocalFileService, S3FileService],
  exports: [FileService, S3FileService],
})
export class FileModule {}
