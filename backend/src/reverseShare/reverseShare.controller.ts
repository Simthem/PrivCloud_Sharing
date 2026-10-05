import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { ConfigService } from "src/config/config.service";
import { CreateReverseShareDTO } from "./dto/createReverseShare.dto";
import { UpdateReverseShareDTO } from "./dto/updateReverseShare.dto";
import { ReverseShareDTO } from "./dto/reverseShare.dto";
import { ReverseShareTokenWithShares } from "./dto/reverseShareTokenWithShares";
import { ReverseShareOwnerGuard } from "./guards/reverseShareOwner.guard";
import { ReverseShareService } from "./reverseShare.service";
import { isReverseShareFileMetaWriteEnabledFor } from "src/file/file-metadata-scheme";

@Controller("reverseShares")
export class ReverseShareController {
  constructor(
    private reverseShareService: ReverseShareService,
    private config: ConfigService,
  ) {}

  @Post()
  @UseGuards(JwtGuard)
  async create(@Body() body: CreateReverseShareDTO, @GetUser() user: User) {
    if (!user) throw new UnauthorizedException();
    const token = await this.reverseShareService.create(
      body,
      user.id,
      isReverseShareFileMetaWriteEnabledFor(user),
    );

    const link = `${this.config.get("general.appUrl")}/upload/${token}`;

    return { token, link };
  }

  @Throttle({
    default: {
      limit: 20,
      ttl: minutes(1),
    },
  })
  @Get(":reverseShareToken")
  async getByToken(@Param("reverseShareToken") reverseShareToken: string) {
    const isValid = await this.reverseShareService.isValid(reverseShareToken);

    if (!isValid) throw new NotFoundException("Reverse share token not found");

    const rs = await this.reverseShareService.getByToken(reverseShareToken);
    const dto = new ReverseShareDTO().from(rs);
    // Whether uploads to this E2E reverse share encrypt their file names and
    // title with K_rs (FILE_META_V1), as decided for its owner.
    dto.fileMetaV1Write =
      dto.isE2EEncrypted &&
      isReverseShareFileMetaWriteEnabledFor(
        await this.reverseShareService.getCreatorIdentity(rs.creatorId),
      );
    return dto;
  }

  @Get()
  @UseGuards(JwtGuard)
  async getAllByUser(@GetUser() user: User) {
    if (!user) throw new UnauthorizedException();
    return new ReverseShareTokenWithShares().fromList(
      await this.reverseShareService.getAllByUser(user.id),
    );
  }

  @Delete(":reverseShareId")
  @UseGuards(JwtGuard, ReverseShareOwnerGuard)
  async remove(@Param("reverseShareId") id: string) {
    await this.reverseShareService.remove(id);
  }

  @Patch(":reverseShareId")
  @UseGuards(JwtGuard, ReverseShareOwnerGuard)
  async update(
    @Param("reverseShareId") id: string,
    @Body() body: UpdateReverseShareDTO,
  ) {
    await this.reverseShareService.update(id, body);
  }
}
