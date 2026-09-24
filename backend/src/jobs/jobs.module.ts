import { Module } from "@nestjs/common";
import { FileModule } from "src/file/file.module";
import { ReverseShareModule } from "src/reverseShare/reverseShare.module";
import { TeamModule } from "src/team/team.module";
import { SigningModule } from "src/signing/signing.module";
import { JobsService } from "./jobs.service";

@Module({
  imports: [FileModule, ReverseShareModule, TeamModule, SigningModule],
  providers: [JobsService],
})
export class JobsModule {}
