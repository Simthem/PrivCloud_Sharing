import { Module } from "@nestjs/common";
import { PrismaModule } from "src/prisma/prisma.module";
import { StepUpService } from "./stepUp.service";

@Module({
  imports: [PrismaModule],
  providers: [StepUpService],
  exports: [StepUpService],
})
export class StepUpModule {}
