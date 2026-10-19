import { Module } from "@nestjs/common";
import { ConfigModule } from "src/config/config.module";
import { PrismaModule } from "src/prisma/prisma.module";
import { AccountPasskeyService } from "./accountPasskey.service";
import { PasskeyController } from "./passkey.controller";

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [PasskeyController],
  providers: [AccountPasskeyService],
  exports: [AccountPasskeyService],
})
export class PasskeyModule {}
