import { Module } from "@nestjs/common";
import { BridgeUploadTokenService } from "./bridge-upload-token.service";

@Module({
  providers: [BridgeUploadTokenService],
  exports: [BridgeUploadTokenService],
})
export class BridgeUploadModule {}
