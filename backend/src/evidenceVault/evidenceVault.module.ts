import { Module } from "@nestjs/common";
import { ConfigModule } from "src/config/config.module";
import { PasskeyModule } from "src/passkey/passkey.module";
import { PrismaModule } from "src/prisma/prisma.module";
import { TeamExternalModule } from "src/teamExternal/team-external.module";
import { EvidenceVaultController } from "./evidenceVault.controller";
import { EvidenceVaultGuard } from "./evidenceVault.guard";
import { EvidenceVaultService } from "./evidenceVault.service";

@Module({
  imports: [ConfigModule, PasskeyModule, PrismaModule, TeamExternalModule],
  controllers: [EvidenceVaultController],
  providers: [EvidenceVaultService, EvidenceVaultGuard],
})
export class EvidenceVaultModule {}
