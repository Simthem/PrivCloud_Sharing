import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  DefaultValuePipe,
  BadRequestException,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { CreateTeamFileRequestDTO } from "./dto/create-team-file-request.dto";
import { TeamFileRequestService } from "./team-file-request.service";

@Controller("teams/:teamId/file-requests")
@UseGuards(JwtGuard)
export class TeamFileRequestController {
  constructor(private service: TeamFileRequestService) {}

  @Get("options")
  @Header("Cache-Control", "private, no-store")
  options(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
  ) {
    return this.service.options(teamId, user.id);
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    if (offset < 0 || offset > 10000)
      throw new BadRequestException("Invalid offset");
    return this.service.list(teamId, user.id, offset);
  }

  @Get(":requestId")
  @Header("Cache-Control", "private, no-store")
  get(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @GetUser() user: User,
  ) {
    return this.service.get(teamId, requestId, user.id);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: minutes(1) } })
  create(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Body() dto: CreateTeamFileRequestDTO,
    @GetUser() user: User,
  ) {
    return this.service.create(teamId, user.id, dto);
  }

  @Patch(":requestId/close")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  close(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @GetUser() user: User,
  ) {
    return this.service.close(teamId, requestId, user.id);
  }
}
