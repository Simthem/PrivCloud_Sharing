import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { AuthenticatedUserGuard } from "src/auth/guard/authenticatedUser.guard";
import {
  ApproveIssuanceDTO,
  CreateExternalPreviewDTO,
  InviteExternalSeatDTO,
  PrepareIssuanceDTO,
  SetTeamAuditKeyDTO,
  UpdateExternalSeatDTO,
} from "./dto/team-external.dto";
import { TeamExternalAuditService } from "./team-external-audit.service";
import { TeamExternalService } from "./team-external.service";
import { TeamExternalRevocationService } from "./team-external-revocation.service";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";
import {
  EvidenceDownloadOptionsDTO,
  ExternalRevocationWatchDTO,
} from "./dto/team-external.dto";

/** Team administrators managing their external contractors. */
@Controller("teams/:teamId/external")
@UseGuards(AuthenticatedUserGuard)
export class TeamExternalAdminController {
  constructor(
    private service: TeamExternalService,
    private audit: TeamExternalAuditService,
    private reminders: TeamExternalRevocationService,
  ) {}

  @Get("seats")
  @Header("Cache-Control", "private, no-store")
  async listSeats(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
  ) {
    const result = await this.service.listSeats(teamId, user);
    const preferences = await this.reminders.preferences(teamId, user);
    return {
      ...result,
      seats: result.seats.map((seat) => ({
        ...seat,
        reminderMode:
          preferences.find((preference) => preference.seatId === seat.id)
            ?.mode ?? "NONE",
      })),
    };
  }

  @Patch("seats/:seatId/revocation-reminder")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  setRevocationReminder(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("seatId", ParseUUIDPipe) seatId: string,
    @Body() dto: ExternalRevocationWatchDTO,
    @GetUser() user: User,
  ) {
    return this.reminders.setPreference(teamId, seatId, user, dto.mode);
  }

  @Post("seats")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  inviteSeat(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Body() dto: InviteExternalSeatDTO,
    @GetUser() user: User,
  ) {
    return this.service.inviteSeat(teamId, user, dto);
  }

  @Patch("seats/:seatId")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  updateSeat(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("seatId", ParseUUIDPipe) seatId: string,
    @Body() dto: UpdateExternalSeatDTO,
    @GetUser() user: User,
  ) {
    return this.service.updateSeat(teamId, seatId, user, dto);
  }

  @Delete("seats/:seatId")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  async revokeSeat(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("seatId", ParseUUIDPipe) seatId: string,
    @GetUser() user: User,
  ) {
    const result = await this.service.revokeSeat(teamId, seatId, user);
    void this.reminders.notifyEndedAccess(teamId, seatId);
    return result;
  }

  @Get("seats/:seatId/keys")
  @Header("Cache-Control", "private, no-store")
  getSeatKeys(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("seatId", ParseUUIDPipe) seatId: string,
    @GetUser() user: User,
  ) {
    return this.service.getSeatRecipientKeys(teamId, seatId, user);
  }

  @Get("previews")
  @Header("Cache-Control", "private, no-store")
  listPreviews(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
  ) {
    return this.service.listPreviews(teamId, user);
  }

  @Post("previews")
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  createPreview(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Body() dto: CreateExternalPreviewDTO,
    @GetUser() user: User,
  ) {
    return this.service.createPreview(teamId, user, dto);
  }

  @Put("previews/:previewId/pages/:index")
  @Throttle({ default: { limit: 600, ttl: minutes(1) } })
  uploadPage(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @Param("index", ParseIntPipe) index: number,
    @Body() body: unknown,
    @GetUser() user: User,
  ) {
    return this.service.uploadPage(teamId, previewId, index, user, body);
  }

  @Post("previews/:previewId/complete")
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  completePreview(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @GetUser() user: User,
  ) {
    return this.service.completePreview(teamId, previewId, user);
  }

  @Delete("previews/:previewId")
  @Throttle({ default: { limit: 60, ttl: minutes(1) } })
  deletePreview(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @GetUser() user: User,
  ) {
    return this.service.deletePreview(teamId, previewId, user);
  }

  /** Register entry of a copy and the passkey options approving it. */
  @Post("previews/:previewId/issuance")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  prepareIssuance(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @Body() dto: PrepareIssuanceDTO,
    @GetUser() user: User,
  ) {
    return this.audit.prepareIssuance(teamId, previewId, user, dto);
  }

  @Post("previews/:previewId/issuance/approve")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  approveIssuance(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @Body() dto: ApproveIssuanceDTO,
    @GetUser() user: User,
  ) {
    return this.audit.approveIssuance(teamId, previewId, user, dto);
  }

  @Get("issuances")
  @Header("Cache-Control", "private, no-store")
  listIssuances(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
  ) {
    return this.audit.listIssuances(teamId, user);
  }

  @Post("issuances/:issuanceId/download/options")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  prepareDownload(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @Body() dto: EvidenceDownloadOptionsDTO,
    @GetUser() user: User,
  ) {
    return this.audit.prepareDownload(teamId, issuanceId, user, dto.kind);
  }

  @Post("issuances/:issuanceId/pattern")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  async patternExport(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @Body() dto: PasskeyResponseDTO,
    @GetUser() user: User,
  ) {
    return this.audit.authorizePatternExport(teamId, issuanceId, user, dto);
  }

  @Post("issuances/:issuanceId/certificate")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  async certificate(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @Body() dto: PasskeyResponseDTO,
    @GetUser() user: User,
  ) {
    const pdf = await this.audit.certificate(teamId, issuanceId, user, dto);
    return new StreamableFile(pdf, {
      type: "application/pdf",
      length: pdf.length,
      disposition: 'attachment; filename="certificat.pdf"',
    });
  }

  @Post("issuances/:issuanceId/evidence")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  async evidence(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("issuanceId", ParseUUIDPipe) issuanceId: string,
    @Body() dto: PasskeyResponseDTO,
    @GetUser() user: User,
  ) {
    const bundle = await this.audit.evidenceBundle(
      teamId,
      issuanceId,
      user,
      dto,
    );
    return new StreamableFile(bundle, {
      type: "application/zip",
      length: bundle.length,
      disposition: 'attachment; filename="dossier-de-preuve.zip"',
    });
  }

  @Get("journal")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  journal(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Query("previewId", new ParseUUIDPipe({ optional: true }))
    previewId: string | undefined,
    @GetUser() user: User,
  ) {
    return this.audit.listJournal(teamId, user, previewId);
  }

  @Get("audit-key")
  @Header("Cache-Control", "private, no-store")
  getAuditKey(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
  ) {
    return this.audit.getAuditKey(teamId, user);
  }

  @Get("journal/diagnostic")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 5, ttl: minutes(1) } })
  journalDiagnostic(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @GetUser() user: User,
  ) {
    return this.audit.journalDiagnostic(teamId, user);
  }

  @Post("audit-key")
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  createAuditKey(
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Body() dto: SetTeamAuditKeyDTO,
    @GetUser() user: User,
  ) {
    return this.audit.createAuditKey(teamId, user, dto);
  }
}

/** Signed-out visitors opening an invitation link. */
@Controller("external")
export class TeamExternalInvitationController {
  constructor(private service: TeamExternalService) {}

  @Get("invitations/:token/account")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  account(@Param("token") token: string) {
    return this.service.getInvitationAccount(token);
  }
}

/**
 * External contractors. Only the rendered, encrypted pages of their own seat
 * are reachable here, and no team route accepts them since they are not team
 * members.
 */
@Controller("external")
@UseGuards(AuthenticatedUserGuard)
export class TeamExternalContractorController {
  constructor(private service: TeamExternalService) {}

  @Get("status")
  @Header("Cache-Control", "private, no-store")
  status(@GetUser() user: User) {
    return this.service.getContractorStatus(user);
  }

  @Get("invitations/:token")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  getInvitation(@Param("token") token: string, @GetUser() user: User) {
    return this.service.getInvitation(token, user);
  }

  @Post("invitations/:token/accept")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  acceptInvitation(@Param("token") token: string, @GetUser() user: User) {
    return this.service.acceptInvitation(token, user);
  }

  @Get("previews")
  @Header("Cache-Control", "private, no-store")
  listPreviews(@GetUser() user: User) {
    return this.service.listContractorPreviews(user);
  }

  @Get("previews/:previewId")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: minutes(1) } })
  getPreview(
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @GetUser() user: User,
  ) {
    return this.service.getContractorPreview(user, previewId);
  }

  @Get("previews/:previewId/pages/:index")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 600, ttl: minutes(1) } })
  async getPage(
    @Param("previewId", ParseUUIDPipe) previewId: string,
    @Param("index", ParseIntPipe) index: number,
    @GetUser() user: User,
  ) {
    const page = await this.service.getContractorPage(user, previewId, index);
    return new StreamableFile(page, {
      type: "application/octet-stream",
      length: page.length,
    });
  }
}
