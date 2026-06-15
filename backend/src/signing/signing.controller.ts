import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  Headers,
  UseGuards,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { User } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { SigningService } from "./signing.service";
import { SigningOtpService } from "./signing-otp.service";
import { SigningDownloadService } from "./signing-download.service";
import { SigningE2EService } from "./signing-e2e.service";
import { CreateSignatureRequestDTO } from "./dto/createSignatureRequest.dto";
import { SignDocumentDTO, RejectDocumentDTO, VerifyOtpDTO, SignE2EPdfDTO, FinalizeE2EDTO } from "./dto/signDocument.dto";

@Controller("signing")
export class SigningController {
  constructor(
    private signingService: SigningService,
    private signingOtpService: SigningOtpService,
    private signingDownloadService: SigningDownloadService,
    private signingE2EService: SigningE2EService,
  ) {}

  private setPublicSigningHeaders(res: Response) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  // =========================================================================
  // AUTHENTICATED ENDPOINTS (document creator)
  // =========================================================================

  /**
   * Create a new signature request for a PDF file.
   */
  @Post("request")
  @UseGuards(JwtGuard)
  async createSignatureRequest(
    @Body() dto: CreateSignatureRequestDTO,
    @GetUser() user: User,
  ) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.createSignatureRequest(dto, user);
  }

  /**
   * Get all signature documents created by the current user.
   */
  @Get("documents")
  @UseGuards(JwtGuard)
  async getMyDocuments(@GetUser() user: User) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.getMyDocuments(user.id);
  }

  /**
   * Get documents where the current user is a recipient (signed or to sign).
   */
  @Get("received")
  @UseGuards(JwtGuard)
  async getReceivedDocuments(@GetUser() user: User) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.getReceivedDocuments(user.id);
  }

  /**
   * Get all signature documents for a team.
   * Only team members can access this.
   */
  @Get("team/:teamId")
  @UseGuards(JwtGuard)
  async getTeamDocuments(
    @Param("teamId") teamId: string,
    @GetUser() user: User,
  ) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.getTeamDocuments(teamId, user.id);
  }

  /**
   * Get a specific signature document with details.
   */
  @Get("documents/:id")
  @UseGuards(JwtGuard)
  async getDocument(@Param("id") id: string, @GetUser() user: User) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.getDocument(id, user.id);
  }

  /**
   * Cancel a pending signature request.
   */
  @Delete("documents/:id")
  @UseGuards(JwtGuard)
  async cancelDocument(@Param("id") id: string, @GetUser() user: User) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.cancelDocument(id, user.id);
  }

  /**
   * Send a reminder to pending signers.
   */
  @Post("documents/:id/remind")
  @UseGuards(JwtGuard)
  async sendReminder(@Param("id") id: string, @GetUser() user: User) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.sendReminder(id, user.id);
  }

  /**
   * Retry server-side finalization for a non-E2E document stuck in AWAITING_FINALIZATION.
   */
  @Post("documents/:id/retry-finalize")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 3, ttl: 3600 } })
  async retryFinalize(@Param("id") id: string, @GetUser() user: User) {
    if (!user?.id) throw new BadRequestException("Authentication required");
    return this.signingService.retryFinalize(id, user.id);
  }

  /**
   * Download the signed PDF.
   */
  @Get("documents/:id/download")
  @UseGuards(JwtGuard)
  async downloadSignedPdf(
    @Param("id") id: string,
    @GetUser() user: User,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.signingDownloadService.getSignedPdf(
      id,
      user.id,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  /**
   * Download the original (encrypted) PDF for E2E finalization.
   */
  @Get("documents/:id/original")
  @UseGuards(JwtGuard)
  async downloadOriginalPdf(
    @Param("id") id: string,
    @GetUser() user: User,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.signingDownloadService.getOriginalPdfForOwner(
      id,
      user.id,
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  /**
   * Get the audit trail for a document.
   */
  @Get("documents/:id/audit")
  @UseGuards(JwtGuard)
  async getAuditTrail(@Param("id") id: string, @GetUser() user: User) {
    return this.signingDownloadService.getAuditTrail(id, user.id);
  }

  /**
   * Get signer data for E2E client-side finalization.
   */
  @Get("documents/:id/signatures")
  @UseGuards(JwtGuard)
  async getSignaturesForFinalization(
    @Param("id") id: string,
    @GetUser() user: User,
  ) {
    return this.signingE2EService.getSignaturesForFinalization(id, user.id);
  }

  /**
   * E2E Step 1: Apply certificate page + cryptographic PAdES signature.
   * Client sends the decrypted PDF (with visual signatures). Backend signs it
   * and returns the signed PDF in base64 (NOT stored).
   */
  @Post("documents/:id/sign-e2e")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 5, ttl: 3600 } })
  async signE2EPdf(
    @Param("id") id: string,
    @GetUser() user: User,
    @Body() dto: SignE2EPdfDTO,
  ) {
    if (!user?.id) throw new BadRequestException("Authentication required");

    const pdfBuffer = Buffer.from(dto.plaintextPdf, "base64");
    if (pdfBuffer.length < 4 || pdfBuffer.slice(0, 4).toString() !== "%PDF") {
      throw new BadRequestException("Invalid PDF data");
    }

    const signedPdf = await this.signingE2EService.signE2EPdf(id, user.id, pdfBuffer);
    return { signedPdf: signedPdf.toString("base64") };
  }

  /**
   * E2E Step 2: Store the re-encrypted signed PDF and mark COMPLETED.
   */
  @Post("documents/:id/finalize-e2e")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 5, ttl: 3600 } })
  async finalizeE2E(
    @Param("id") id: string,
    @GetUser() user: User,
    @Body() dto: FinalizeE2EDTO,
  ) {
    if (!user?.id) throw new BadRequestException("Authentication required");

    const pdfBuffer = Buffer.from(dto.encryptedPdf, "base64");
    if (!pdfBuffer.length) {
      throw new BadRequestException("Empty PDF data");
    }

    return this.signingE2EService.storeE2EFinal(id, user.id, pdfBuffer);
  }

  // =========================================================================
  // PUBLIC SIGNING ENDPOINTS (recipient via token)
  // =========================================================================

  /**
   * Get signing page data for a recipient.
   * Authentication is via the signing token (URL parameter).
   */
  @Get("sign/:token")
  async getSigningPage(
    @Param("token") token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setPublicSigningHeaders(res);
    return this.signingService.getSigningPage(token);
  }

  /**
   * Stream the original PDF for preview — public, token-gated.
   */
  @Get("sign/:token/preview")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async previewOriginalPdf(
    @Param("token") token: string,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.signingDownloadService.getOriginalPdfForPreview(token);
    this.setPublicSigningHeaders(res);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  }

  /**
   * Download the signed PDF via signing token — public, available once COMPLETED.
   */
  @Get("sign/:token/download-signed")
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async downloadSignedPdfPublic(
    @Param("token") token: string,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.signingDownloadService.getSignedPdfByToken(token);
    this.setPublicSigningHeaders(res);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  }

  /**
   * Request OTP for identity verification (AES level).
   */
  @Post("sign/:token/otp/send")
  @Throttle({ default: { limit: 3, ttl: 60 } })
  async sendOtp(
    @Param("token") token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setPublicSigningHeaders(res);
    return this.signingOtpService.sendOtp(token);
  }

  /**
   * Verify OTP code.
   */
  @Post("sign/:token/otp/verify")
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async verifyOtp(
    @Param("token") token: string,
    @Body() dto: VerifyOtpDTO,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setPublicSigningHeaders(res);
    return this.signingOtpService.verifyOtp(token, dto.otpCode);
  }

  /**
   * Sign the document.
   */
  @Post("sign/:token/sign")
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async signDocument(
    @Param("token") token: string,
    @Body() dto: SignDocumentDTO,
    @Ip() ip: string,
    @Headers("x-forwarded-for") forwardedFor: string,
    @Headers("user-agent") userAgent: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setPublicSigningHeaders(res);
    // Use the first IP from X-Forwarded-For if available (real client IP behind proxy)
    const clientIp = forwardedFor
      ? forwardedFor.split(",")[0].trim()
      : ip;
    return this.signingService.signDocument(token, dto, clientIp, userAgent || "");
  }

  /**
   * Reject the document.
   */
  @Post("sign/:token/reject")
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async rejectDocument(
    @Param("token") token: string,
    @Body() dto: RejectDocumentDTO,
    @Ip() ip: string,
    @Headers("x-forwarded-for") forwardedFor: string,
    @Headers("user-agent") userAgent: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setPublicSigningHeaders(res);
    const clientIp = forwardedFor
      ? forwardedFor.split(",")[0].trim()
      : ip;
    return this.signingService.rejectDocument(
      token,
      dto.reason,
      clientIp,
      userAgent || "",
    );
  }
}
