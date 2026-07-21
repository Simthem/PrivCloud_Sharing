import { Module } from "@nestjs/common";
import { FileModule } from "src/file/file.module";
import { ReverseShareModule } from "src/reverseShare/reverseShare.module";
import { TeamModule } from "src/team/team.module";
import { JobsService } from "./jobs.service";

@Module({
  imports: [FileModule, ReverseShareModule, TeamModule],
  providers: [JobsService],
})
export class JobsModule {}
