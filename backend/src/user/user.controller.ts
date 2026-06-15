import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { Response } from "express";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "../config/config.service";
import { CreateUserDTO } from "./dto/createUser.dto";
import { EncryptionKeyHashDTO } from "./dto/encryptionKey.dto";
import { WrappedKeyDTO } from "./dto/wrappedKey.dto";
import { UpdateOwnUserDTO } from "./dto/updateOwnUser.dto";
import { UpdateUserDto } from "./dto/updateUser.dto";
import { UserDTO } from "./dto/user.dto";
import { UserSevice } from "./user.service";
import { AuthTotpService } from "src/auth/authTotp.service";

@Controller("users")
export class UserController {
  constructor(
    private userService: UserSevice,
    private config: ConfigService,
    private authTotpService: AuthTotpService,
    private prisma: PrismaService,
  ) {}

  // Own user operations
  @Get("me")
  @UseGuards(JwtGuard)
  async getCurrentUser(@GetUser() user?: User) {
    if (!user) return null;
    const userDTO = new UserDTO().from(user);
    userDTO.hasPassword = !!user.password;

    const sub = { plan: "TEAM", status: "active" };
    userDTO.plan = sub.plan;
    userDTO.planStatus = sub.status;

    // Check active team membership for users invited into an existing team.
    const teamMembership = await this.prisma.teamMember.findFirst({
      where: { userId: user.id, isActive: true },
      select: { teamId: true },
    });

    return {
      ...userDTO,
      hasTeamMembership: !!teamMembership,
      teamId: teamMembership?.teamId || null,
      subscription: {
        plan: sub.plan,
        status: sub.status,
      },
    };
  }

  @Patch("me")
  @UseGuards(JwtGuard)
  async updateCurrentUser(
    @GetUser() user: User,
    @Body() data: UpdateOwnUserDTO,
  ) {
    if (!user?.id) throw new UnauthorizedException();
    return new UserDTO().from(await this.userService.update(user.id, data));
  }

  @Delete("me")
  @HttpCode(204)
  @UseGuards(JwtGuard)
  async deleteCurrentUser(
    @GetUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!user?.id) throw new UnauthorizedException();
    await this.userService.delete(user.id);

    const isSecure = this.config.get("general.secureCookies");

    response.cookie("access_token", "", {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: -1,
      secure: isSecure,
    });
    response.cookie("refresh_token", "", {
      path: "/api/auth/token",
      httpOnly: true,
      sameSite: "strict",
      maxAge: -1,
      secure: isSecure,
    });
    response.cookie("logged_in", "", {
      path: "/",
      httpOnly: false,
      sameSite: "strict",
      maxAge: -1,
      secure: isSecure,
    });
  }

  // --- E2E Encryption Key Management ------------------------------

  @Put("me/encryption-key")
  @UseGuards(JwtGuard)
  async setEncryptionKey(
    @GetUser() user: User,
    @Body() dto: EncryptionKeyHashDTO,
  ) {
    if (!user?.id) throw new UnauthorizedException();
    await this.userService.setEncryptionKeyHash(user.id, dto.keyHash);
    return { hasEncryptionKey: true };
  }

  @Delete("me/encryption-key")
  @HttpCode(204)
  @UseGuards(JwtGuard)
  async removeEncryptionKey(@GetUser() user: User) {
    if (!user?.id) throw new UnauthorizedException();
    await this.userService.removeEncryptionKeyHash(user.id);
    // Also purge all wrapped keys - they reference the revoked E2E key
    await this.userService.removeAllWrappedKeys(user.id);
  }

  @Post("me/encryption-key/verify")
  @UseGuards(JwtGuard)
  async verifyEncryptionKey(
    @GetUser() user: User,
    @Body() dto: EncryptionKeyHashDTO,
  ) {
    if (!user?.id) throw new UnauthorizedException();
    const valid = await this.userService.verifyEncryptionKeyHash(
      user.id,
      dto.keyHash,
    );
    return { valid };
  }

  // --- Passkey Wrapped Keys (multi-device sync) ------------------

  @Put("me/wrapped-keys")
  @UseGuards(JwtGuard)
  async setWrappedKey(
    @GetUser() user: User,
    @Body() dto: WrappedKeyDTO,
  ) {
    if (!user?.id) throw new UnauthorizedException();
    await this.userService.setWrappedKey(user.id, dto);
    return { ok: true };
  }

  @Get("me/wrapped-keys")
  @UseGuards(JwtGuard)
  async listWrappedKeys(@GetUser() user: User) {
    if (!user?.id) throw new UnauthorizedException();
    return this.userService.listWrappedKeys(user.id);
  }

  @Delete("me/wrapped-keys/:credentialId")
  @HttpCode(204)
  @UseGuards(JwtGuard)
  async removeWrappedKey(
    @GetUser() user: User,
    @Param("credentialId") credentialId: string,
  ) {
    if (!user?.id) throw new UnauthorizedException();
    await this.userService.removeWrappedKey(user.id, credentialId);
  }

  // Global user operations
  @Get()
  @UseGuards(JwtGuard, AdministratorGuard)
  async list() {
    const users = await this.userService.list();
    return users.map((user) => {
      const dto = new UserDTO().from(user);
      dto.createdAt = user.createdAt;
      const sub = (user as Record<string, unknown>).subscription as
        | { plan: string; status: string }
        | undefined;
      dto.plan = sub?.plan || "TEAM";
      dto.planStatus = sub?.status || "active";
      return dto;
    });
  }

  @Post()
  @UseGuards(JwtGuard, AdministratorGuard)
  async create(@Body() user: CreateUserDTO) {
    return new UserDTO().from(await this.userService.create(user));
  }

  @Patch(":id")
  @UseGuards(JwtGuard, AdministratorGuard)
  async update(@Param("id") id: string, @Body() user: UpdateUserDto) {
    return new UserDTO().from(await this.userService.update(id, user));
  }

  @Delete(":id/totp")
  @HttpCode(204)
  @UseGuards(JwtGuard, AdministratorGuard)
  async adminDisableTotp(@Param("id") id: string) {
    await this.authTotpService.adminDisableTotp(id);
  }

  @Delete(":id")
  @UseGuards(JwtGuard, AdministratorGuard)
  async delete(@Param("id") id: string) {
    return new UserDTO().from(await this.userService.delete(id));
  }
}
