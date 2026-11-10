import { Global, Module } from "@nestjs/common";
import { Config } from "@prisma/client";
import { EmailModule } from "src/email/email.module";
import { PrismaService } from "src/prisma/prisma.service";
import {
  applyConfigEncryption,
  loadConfigKey,
  openRows,
} from "./config-encryption";
import { applyAccountEncryption } from "./account-secrets";
import { ConfigController } from "./config.controller";
import { ConfigService } from "./config.service";
import { LogoService } from "./logo.service";
import { StepUpModule } from "src/auth/stepUp.module";

@Global()
@Module({
  imports: [EmailModule, StepUpModule],
  providers: [
    {
      provide: "CONFIG_VARIABLES",
      useFactory: async (prisma: PrismaService) => {
        const key = loadConfigKey();
        await applyConfigEncryption(prisma, key);
        const rows = openRows(await prisma.config.findMany(), key);
        await applyAccountEncryption(prisma.storedClient(), key);
        return rows;
      },
      inject: [PrismaService],
    },
    {
      provide: ConfigService,
      useFactory: async (prisma: PrismaService, configVariables: Config[]) => {
        const configService = new ConfigService(configVariables, prisma);
        await configService.initialize();
        return configService;
      },
      inject: [PrismaService, "CONFIG_VARIABLES"],
    },
    LogoService,
  ],
  controllers: [ConfigController],
  exports: [ConfigService],
})
export class ConfigModule {}
