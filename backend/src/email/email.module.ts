import { Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { EmailOutboxService } from "./email-outbox.service";

@Module({
  providers: [EmailService, EmailOutboxService],
  exports: [EmailService, EmailOutboxService],
})
export class EmailModule {}
