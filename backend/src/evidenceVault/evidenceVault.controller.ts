import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { Request, Response } from "express";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { AuthenticatedUserGuard } from "src/auth/guard/authenticatedUser.guard";
import { ConfigService } from "src/config/config.service";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";
import { EraseVaultTeamDTO } from "./dto/eraseVaultTeam.dto";
import { EvidenceVaultGuard } from "./evidenceVault.guard";
import {
  EVIDENCE_VAULT_COOKIE,
  EVIDENCE_VAULT_COOKIE_PATH,
  EVIDENCE_VAULT_TTL_MS,
  EvidenceVaultService,
} from "./evidenceVault.service";

/** Evidence vault of the platform administrators. */
@Controller("admin/evidence-vault")
@UseGuards(AuthenticatedUserGuard, AdministratorGuard)
export class EvidenceVaultController {
  constructor(
    private vault: EvidenceVaultService,
    private config: ConfigService,
  ) {}

  @Get("status")
  @Header("Cache-Control", "private, no-store")
  async status(@Req() request: Request, @GetUser() user: User) {
    const openUntil = await this.vault.openUntil(
      request.cookies?.[EVIDENCE_VAULT_COOKIE],
      user,
    );
    return { open: !!openUntil, openUntil };
  }

  @Post("unlock/options")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: minutes(5) } })
  unlockOptions(@GetUser() user: User) {
    return this.vault.beginUnlock(user);
  }

  @Post("unlock")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: minutes(5) } })
  async unlock(
    @Body() dto: PasskeyResponseDTO,
    @GetUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { value, expiresAt } = await this.vault.unlock(user, dto);
    response.cookie(EVIDENCE_VAULT_COOKIE, value, {
      path: EVIDENCE_VAULT_COOKIE_PATH,
      sameSite: "strict",
      secure: this.config.get("general.secureCookies"),
      httpOnly: true,
      maxAge: EVIDENCE_VAULT_TTL_MS,
    });
    return { open: true, openUntil: expiresAt };
  }

  @Post("lock")
  @HttpCode(200)
  async lock(
    @GetUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.vault.lock(user);
    response.clearCookie(EVIDENCE_VAULT_COOKIE, {
      path: EVIDENCE_VAULT_COOKIE_PATH,
    });
    return { open: false };
  }

  @Get("teams")
  @UseGuards(EvidenceVaultGuard)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: minutes(1) } })
  teams(@Query("search") search?: string) {
    return this.vault.teams(search);
  }

  @Get("teams/:teamId/issuances")
  @UseGuards(EvidenceVaultGuard)
  @Header("Cache-Control", "private, no-store")
  issuances(@Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.vault.issuances(teamId);
  }

  @Get("teams/:teamId/issuances/:issuanceId/certificate")
  @UseGuards(EvidenceVaultGuard)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  async certificate(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @GetUser() user: User,
  ) {
    const pdf = await this.vault.certificate(teamId, issuanceId, user);
    return new StreamableFile(pdf, {
      type: "application/pdf",
      length: pdf.length,
      disposition: 'attachment; filename="certificat.pdf"',
    });
  }

  @Get("teams/:teamId/issuances/:issuanceId/evidence")
  @UseGuards(EvidenceVaultGuard)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  async evidence(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @GetUser() user: User,
  ) {
    const bundle = await this.vault.evidence(teamId, issuanceId, user);
    return new StreamableFile(bundle, {
      type: "application/zip",
      length: bundle.length,
      disposition: 'attachment; filename="dossier-de-preuve.zip"',
    });
  }

  @Get("teams/:teamId/issuances/:issuanceId/journal")
  @UseGuards(EvidenceVaultGuard)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  journal(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @GetUser() user: User,
  ) {
    return this.vault.journal(teamId, issuanceId, user);
  }

  @Post("teams/:teamId/erase")
  @HttpCode(200)
  @UseGuards(EvidenceVaultGuard)
  @Throttle({ default: { limit: 5, ttl: minutes(10) } })
  erase(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Body() dto: EraseVaultTeamDTO,
    @GetUser() user: User,
  ) {
    return this.vault.erase(teamId, dto.confirmation, user);
  }
}
