import {
  Body,
  Controller,
  FileTypeValidator,
  Get,
  Param,
  ParseFilePipe,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import "multer";
import { SkipThrottle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { Request } from "express";
import { StepUpService } from "src/auth/stepUp.service";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { EmailService } from "src/email/email.service";
import {
  ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES,
  AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
} from "src/file/upload-limit.util";
import { ConfigService } from "./config.service";
import { AdminConfigDTO } from "./dto/adminConfig.dto";
import { ConfigDTO } from "./dto/config.dto";
import { TestEmailDTO } from "./dto/testEmail.dto";
import UpdateConfigDTO from "./dto/updateConfig.dto";
import { LogoService } from "./logo.service";
import { LOGO_UPLOAD_OPTIONS } from "./logo-upload.config";
import { NoCacheInterceptor } from "./interceptor/no-cache.interceptor";

// Settings an administrator may change without confirming their identity.
const UNCONFIRMED_CONFIG_CATEGORIES = [
  "announcement",
  "share",
  "cache",
  "legal",
  "pushNotifications",
  "team",
];

@Controller("configs")
@UseInterceptors(NoCacheInterceptor)
export class ConfigController {
  constructor(
    private configService: ConfigService,
    private logoService: LogoService,
    private emailService: EmailService,
    private stepUp: StepUpService,
  ) {}

  @Get()
  @SkipThrottle()
  async list() {
    return new ConfigDTO().fromList([
      {
        key: "runtime.uploadMaxChunkBytes",
        value: String(MAX_UPLOAD_CHUNK_BYTES),
        type: "filesize",
      },
      {
        key: "runtime.uploadAnonymousMaxChunkBytes",
        value: String(ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES),
        type: "filesize",
      },
      {
        key: "runtime.uploadAuthenticatedMaxChunkBytes",
        value: String(AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES),
        type: "filesize",
      },
      ...(await this.configService.list()),
    ]);
  }

  @Get("admin/:category")
  @UseGuards(JwtGuard, AdministratorGuard)
  async getByCategory(@Param("category") category: string) {
    return new AdminConfigDTO().fromList(
      await this.configService.getByCategory(category),
    );
  }

  @Patch("admin")
  @UseGuards(JwtGuard, AdministratorGuard)
  async updateMany(
    @Body() data: UpdateConfigDTO[],
    @GetUser() admin: User,
    @Req() request: Request,
  ) {
    // Addresses, sign-in providers, the directory, mail delivery and the
    // security policy decide who gets into which account.
    if (
      !Array.isArray(data) ||
      data.some(
        (variable) =>
          !UNCONFIRMED_CONFIG_CATEGORIES.includes(
            String(variable?.key).split(".")[0],
          ),
      )
    ) {
      await this.stepUp.consume(request, admin, "config.update");
    }
    return new AdminConfigDTO().fromList(
      await this.configService.updateMany(data),
    );
  }

  @Post("admin/testEmail")
  @UseGuards(JwtGuard, AdministratorGuard)
  async testEmail(@Body() { email }: TestEmailDTO) {
    await this.emailService.sendTestMail(email);
  }

  @Post("admin/logo")
  @UseInterceptors(FileInterceptor("file", LOGO_UPLOAD_OPTIONS))
  @UseGuards(JwtGuard, AdministratorGuard)
  async uploadLogo(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: /^image\/(png|jpe?g|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return await this.logoService.create(file.buffer);
  }
}
