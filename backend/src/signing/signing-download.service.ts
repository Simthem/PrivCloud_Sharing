import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { provenAccountEmail } from "./signing-identity.util";
import { findByToken } from "../config/account-secrets";
import { PrismaService } from "src/prisma/prisma.service";
import { appendSignatureAuditEvent } from "./signing-audit.util";
import { toVisibleAuditEvent } from "./signing-exposure.util";
import { FileService } from "src/file/file.service";
import { holdsSigningEmailSession } from "./signing-email-session.util";
import { signedFileName, signingLanguage } from "./signing-language";

@Injectable()
export class SigningDownloadService {
  private readonly logger = new Logger(SigningDownloadService.name);

  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
  ) {}

  private assertSourceAvailable(document: {
    fileId?: string | null;
    fileDeletedAt?: Date | null;
  }) {
    if (document.fileDeletedAt || document.fileId === null) {
      throw new NotFoundException(
        "The source file was deleted; signing files are no longer available",
      );
    }
  }

  /**
   * Download the signed PDF (only after completion).
   */
  async getSignedPdf(
    documentId: string,
    userId: string,
  ): Promise<{
    buffer: Buffer;
    fileName: string;
  }> {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: {
        id: documentId,
        OR: [
          { creatorId: userId },
          { recipients: { some: { userId } } },
          ...(await this.recipientEmailMatch(userId)),
        ],
      },
    });

    if (!doc) throw new NotFoundException("Document not found");
    if (doc.status !== "COMPLETED" || !doc.signedFileKey) {
      throw new BadRequestException("Signed document not yet available");
    }

    const buffer = await this.fileService.getFileByKey(doc.signedFileKey);
    const fileName = signedFileName(
      doc.fileName,
      signingLanguage(doc.language),
    );

    await this.createAuditEvent(documentId, "DOWNLOADED", userId);

    // Log team activity for signed doc download
    if (doc.teamId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      this.logger.log(`Logging DOWNLOAD for team ${doc.teamId}`);
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: doc.teamId,
            action: "DOWNLOAD",
            actorEmail: user?.email || "unknown",
            actorName: user?.username || undefined,
            fileName: fileName,
          },
        })
        .catch(() => this.logger.error("Failed to log DOWNLOAD"));
    }

    return { buffer, fileName };
  }

  /**
   * Download the original (encrypted) PDF for E2E finalization.
   * Only accessible by the document creator when status is AWAITING_FINALIZATION.
   */
  async getOriginalPdfForOwner(
    documentId: string,
    userId: string,
  ): Promise<{
    buffer: Buffer;
    fileName: string;
  }> {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
    });

    if (!doc) throw new NotFoundException("Document not found");
    this.assertSourceAvailable(doc);
    if (!doc.isE2EEncrypted || doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException(
        "Document is not awaiting E2E finalization",
      );
    }

    const buffer = await this.fileService.getFileByKey(doc.originalFileKey);
    return { buffer, fileName: doc.fileName };
  }

  /**
   * Get the original PDF for preview - accessible via the signer's token.
   */
  async getOriginalPdfForPreview(
    signingToken: string,
    userId?: string,
    emailSession?: unknown,
  ): Promise<{
    buffer: Buffer;
    fileName: string;
  }> {
    const recipient = await findByToken("signing", signingToken, (stored) =>
      this.prisma.signatureRecipient.findUnique({
        where: { signingToken: stored },
        include: { document: true },
      }),
    );

    if (!recipient || !recipient.document) {
      throw new NotFoundException("Invalid or expired signing link");
    }

    this.assertSourceAvailable(recipient.document);

    if (recipient.document.status === "CANCELLED") {
      throw new BadRequestException(
        "This signature request has been cancelled",
      );
    }

    if (
      recipient.document.expiresAt &&
      new Date() > recipient.document.expiresAt
    ) {
      throw new BadRequestException("This signature request has expired");
    }

    if (
      recipient.document.signatureLevel === "REINFORCED" &&
      (!userId || recipient.userId !== userId)
    ) {
      throw new ForbiddenException(
        "Sign in with the assigned PrivCloud account to view this document",
      );
    }

    if (
      recipient.document.signatureLevel === "STANDARD" &&
      !holdsSigningEmailSession(recipient, emailSession)
    ) {
      throw new ForbiddenException(
        "Verify the assigned email address to view this document",
      );
    }

    const buffer = await this.fileService.getFileByKey(
      recipient.document.originalFileKey,
    );
    return { buffer, fileName: recipient.document.fileName };
  }

  /**
   * Download the signed PDF via the signer's token - no authentication required.
   * Only available when the document status is COMPLETED.
   */
  async getSignedPdfByToken(
    signingToken: string,
    userId?: string,
  ): Promise<{
    buffer: Buffer;
    fileName: string;
  }> {
    const recipient = await findByToken("signing", signingToken, (stored) =>
      this.prisma.signatureRecipient.findUnique({
        where: { signingToken: stored },
        include: { document: true },
      }),
    );

    if (!recipient || !recipient.document) {
      throw new NotFoundException("Invalid signing link");
    }

    if (
      recipient.document.status !== "COMPLETED" ||
      !recipient.document.signedFileKey
    ) {
      throw new BadRequestException(
        "Le document signé n'est pas encore disponible. Veuillez réessayer dans quelques instants.",
      );
    }

    if (
      recipient.document.signatureLevel === "REINFORCED" &&
      (!userId || recipient.userId !== userId)
    ) {
      throw new ForbiddenException(
        "Sign in with the assigned PrivCloud account to download this document",
      );
    }

    const buffer = await this.fileService.getFileByKey(
      recipient.document.signedFileKey,
    );
    const fileName = signedFileName(
      recipient.document.fileName,
      signingLanguage(recipient.document.language),
    );

    // Anyone holding the link can download: only the assigned account,
    // signed in, is recorded as the recipient.
    const asRecipient = !!userId && userId === recipient.userId;
    await this.createAuditEvent(
      recipient.documentId,
      "DOWNLOADED",
      asRecipient ? userId : `signing-link:${recipient.email}`,
    );

    // Log team activity
    if (recipient.document.teamId) {
      this.logger.log(
        `Logging DOWNLOAD (recipient) for team ${recipient.document.teamId}`,
      );
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: recipient.document.teamId,
            action: "DOWNLOAD",
            actorEmail: asRecipient ? recipient.email : "anonymous",
            actorName: asRecipient
              ? recipient.name || undefined
              : `${recipient.email} (lien de signature)`,
            fileName: fileName,
          },
        })
        .catch(() => this.logger.error("Failed to log DOWNLOAD"));
    }

    return { buffer, fileName };
  }

  /**
   * A signer invited by address, before any account was linked to the
   * request, reaches the document through that address.
   */
  private async recipientEmailMatch(userId: string) {
    const email = await provenAccountEmail(this.prisma, userId);
    return email ? [{ recipients: { some: { email, userId: null } } }] : [];
  }

  /**
   * Get the audit trail for a document.
   */
  async getAuditTrail(documentId: string, userId: string) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: {
        id: documentId,
        OR: [{ creatorId: userId }, { recipients: { some: { userId } } }],
      },
    });

    if (!doc) throw new NotFoundException("Document not found");

    const events = await this.prisma.signatureAuditEvent.findMany({
      where: { documentId },
      orderBy: { createdAt: "asc" },
    });
    return events.map(toVisibleAuditEvent);
  }

  private async createAuditEvent(
    documentId: string,
    eventType: string,
    actor: string,
    ipAddress?: string,
    userAgent?: string,
    metadata?: string,
  ) {
    await appendSignatureAuditEvent(this.prisma, {
      documentId,
      eventType,
      actor,
      ipAddress,
      userAgent,
      metadata,
    });
  }
}
