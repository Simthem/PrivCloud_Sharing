import {
  Body,
  Controller,
  FileTypeValidator,
  Get,
  Param,
  ParseFilePipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import "multer";
import { SkipThrottle } from "@nestjs/throttler";
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
import { NoCacheInterceptor } from "./interceptor/no-cache.interceptor";

@Controller("configs")
@UseInterceptors(NoCacheInterceptor)
export class ConfigController {
  constructor(
    private configService: ConfigService,
    private logoService: LogoService,
    private emailService: EmailService,
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
  async updateMany(@Body() data: UpdateConfigDTO[]) {
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
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 2 * 1024 * 1024 } }),
  )
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
