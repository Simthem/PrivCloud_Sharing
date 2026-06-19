import { Global, Module } from "@nestjs/common";
import { AltchaController } from "./altcha.controller";
import { AltchaGuard } from "./altcha.guard";
import { AltchaService } from "./altcha.service";

@Global()
@Module({
  controllers: [AltchaController],
  providers: [AltchaGuard, AltchaService],
  exports: [AltchaGuard, AltchaService],
})
export class AltchaModule {}
