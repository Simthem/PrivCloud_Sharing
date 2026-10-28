import { Module } from "@nestjs/common";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import { BridgeUploadTokenService } from "./bridge-upload-token.service";

// The share module imports this one, so the stateless access check is
// provided here directly rather than through it.
@Module({
  providers: [BridgeUploadTokenService, TeamShareAccessService],
  exports: [BridgeUploadTokenService],
})
export class BridgeUploadModule {}
