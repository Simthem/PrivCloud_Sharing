import { Module } from "@nestjs/common";
import { EmailModule } from "src/email/email.module";
import { PushModule } from "src/push/push.module";
import { DownloadNotificationService } from "./downloadNotification.service";

@Module({
  imports: [EmailModule, PushModule],
  providers: [DownloadNotificationService],
  exports: [DownloadNotificationService],
})
export class DownloadNotificationModule {}
