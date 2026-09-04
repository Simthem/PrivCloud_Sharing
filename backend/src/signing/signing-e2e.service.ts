import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import { appendSignatureAuditEvent } from "./signing-audit.util";
import { EmailService } from "src/email/email.service";
import { FileService } from "src/file/file.service";
import { ConfigService } from "src/config/config.service";
import { PdfSigningService } from "./pdf-signing.service";
import { deliverSigningCompletionEmails } from "./signing-mail.util";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";

@Injectable()
export class SigningE2EService {
  private readonly logger = new Logger(SigningE2EService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private fileService: FileService,
    private configService: ConfigService,
    private pdfSigningService: PdfSigningService,
    private teamNotificationService: TeamNotificationService,
  ) {}

  private assertSourceAvailable(document: {
    fileId?: string | null;
    fileDeletedAt?: Date | null;
  }) {
    if (document.fileDeletedAt || document.fileId === null) {
      throw new NotFoundException(
        "The source file was deleted; E2E finalization is no longer available",
      );
    }
  }

  /** Generate only the certificate page. The clear source PDF remains client-side. */
  async generateE2ECertificatePage(
    documentId: string,
    userId: string,
    documentHash: string,
  ): Promise<Buffer> {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
      include: { recipients: { where: { role: "SIGNER" } } },
    });

    if (!doc) throw new NotFoundException("Document not found");
    this.assertSourceAvailable(doc);
    if (!doc.isE2EEncrypted)
      throw new BadRequestException("Not an E2E document");
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException(
        `Document status is "${doc.status}", expected "AWAITING_FINALIZATION"`,
      );
    }

    const allSigned = doc.recipients.every((r) => r.status === "SIGNED");
    if (!allSigned) {
      throw new BadRequestException("Not all signers have signed yet");
    }

    const certPage = await this.pdfSigningService.generateCertificatePage({
      documentId: doc.id,
      fileName: doc.fileName,
      signedAt: new Date(),
      signers: doc.recipients.map((r) => ({
        name: r.name,
        email: r.email,
        signedAt: r.signedAt!,
        ip: r.signingIp || "N/A",
        signatureType: r.signatureType || "N/A",
        authenticationMethod: r.authenticationMethod,
        identityVerificationMethod: r.identityVerificationMethod,
        signingIntentHash: r.signingIntentHash,
        signedDocumentHash: r.signedDocumentHash,
        webauthnUserVerified: r.webauthnUserVerified,
      })),
      documentHash,
      signatureLevel: doc.signatureLevel,
    });

    this.logger.log(
      `E2E certificate page generated without source PDF for ${documentId}`,
    );
    return certPage;
  }

  /** Sign only the SHA-256 digest of the client-prepared PDF ByteRange. */
  async signE2EDigest(
    documentId: string,
    userId: string,
    digest: Buffer,
  ): Promise<Buffer> {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
      include: { recipients: { where: { role: "SIGNER" } } },
    });

    if (!doc) throw new NotFoundException("Document not found");
    this.assertSourceAvailable(doc);
    if (!doc.isE2EEncrypted)
      throw new BadRequestException("Not an E2E document");
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException(
        `Document status is "${doc.status}", expected "AWAITING_FINALIZATION"`,
      );
    }
    if (!doc.recipients.every((recipient) => recipient.status === "SIGNED")) {
      throw new BadRequestException("Not all signers have signed yet");
    }

    const cms = await this.pdfSigningService.signDigest(digest);
    await this.createAuditEvent(
      documentId,
      "PADES_DIGEST_SIGNED",
      userId,
      undefined,
      undefined,
      JSON.stringify({ algorithm: "SHA-256", digest: digest.toString("hex") }),
    );

    this.logger.log(`E2E detached PAdES CMS created for ${documentId}`);
    return cms;
  }

  /**
   * E2E Step 2: Store the re-encrypted signed PDF and mark COMPLETED.
   * The client re-encrypts the PAdES-signed PDF and sends it here for storage.
   */
  async storeE2EFinal(
    documentId: string,
    userId: string,
    encryptedPdfBuffer: Buffer,
  ) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
      include: { recipients: { where: { role: "SIGNER" } } },
    });

    if (!doc) throw new NotFoundException("Document not found");
    this.assertSourceAvailable(doc);
    if (!doc.isE2EEncrypted)
      throw new BadRequestException("Not an E2E document");
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException(
        `Document status is "${doc.status}", expected "AWAITING_FINALIZATION"`,
      );
    }

    const allSigned = doc.recipients.every((r) => r.status === "SIGNED");
    if (!allSigned) {
      throw new BadRequestException("Not all signers have signed yet");
    }

    const padesSignature = await this.prisma.signatureAuditEvent.findFirst({
      where: { documentId, eventType: "PADES_DIGEST_SIGNED" },
      select: { id: true },
    });
    if (!padesSignature) {
      throw new BadRequestException(
        "PAdES digest signature is required before finalization",
      );
    }

    // Store the re-encrypted signed PDF
    const signedKey = `signed/${documentId}/${doc.fileName}`;
    await this.fileService.storeFileByKey(signedKey, encryptedPdfBuffer);

    await this.prisma.signatureDocument.update({
      where: { id: documentId },
      data: { status: "COMPLETED", signedFileKey: signedKey },
    });

    await this.createAuditEvent(documentId, "COMPLETED", "client-e2e");

    // The encrypted completion envelope was prepared per recipient when the
    // request was created. Persist each in-app notification only after the
    // requester has uploaded the finalized encrypted PDF.
    if (doc.teamId) {
      try {
        const recipients = await this.prisma.signatureRecipient.findMany({
          where: { documentId },
          select: {
            id: true,
            userId: true,
            teamCompletionNotification: true,
          },
        });
        const targets = recipients.filter(
          (recipient) =>
            recipient.userId && recipient.teamCompletionNotification,
        );
        const activeMembers = await this.prisma.teamMember.findMany({
          where: {
            teamId: doc.teamId,
            isActive: true,
            userId: { in: targets.map((recipient) => recipient.userId!) },
          },
          select: { userId: true },
        });
        const activeIds = new Set(activeMembers.map((member) => member.userId));
        await Promise.all(
          targets
            .filter((recipient) => activeIds.has(recipient.userId!))
            .map((recipient) =>
              this.teamNotificationService.notify({
                type: "SIGNATURE_COMPLETED",
                title: "Document signé disponible",
                teamId: doc.teamId!,
                userId: recipient.userId!,
                actorId: doc.creatorId,
                encryptedMetadata: recipient.teamCompletionNotification!,
              }),
            ),
        );
      } catch (notificationError: any) {
        // Finalization is already durable; a delivery outage must not make the
        // client retry the encrypted PDF upload against a COMPLETED document.
        this.logger.error(
          `E2E completion notification failed for ${documentId}: ${notificationError?.message || notificationError}`,
        );
      }
    }

    // Log team activity
    if (doc.teamId) {
      this.logger.log(
        `Logging SIGNATURE_COMPLETE (E2E) for team ${doc.teamId}`,
      );
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: doc.teamId,
            action: "SIGNATURE_COMPLETE",
            actorEmail: "system",
            actorName: "Finalisation E2E client",
            fileName: doc.fileName,
          },
        })
        .catch((err) =>
          this.logger.error(
            `Failed to log SIGNATURE_COMPLETE (E2E): ${err.message}`,
          ),
        );
    }

    try {
      const [allRecipients, creator, baseUrl] = await Promise.all([
        this.prisma.signatureRecipient.findMany({ where: { documentId } }),
        this.prisma.user.findUnique({ where: { id: doc.creatorId } }),
        Promise.resolve(this.configService.get("general.appUrl")),
      ]);
      await deliverSigningCompletionEmails({
        fileName: doc.fileName,
        documentUrl: `${baseUrl}/signing/${documentId}`,
        teamId: doc.teamId,
        creator,
        recipients: allRecipients,
        sendMail: (email, subject, body) =>
          this.emailService.sendMail(email, subject, body),
        onFailure: (email, error: any) =>
          this.logger.error(
            `E2E completion email failed for ${documentId} to ${email}: ${error?.message || error}`,
          ),
      });
    } catch (notificationError: any) {
      this.logger.error(
        `Failed to prepare E2E completion emails for ${documentId}: ${notificationError?.message || notificationError}`,
      );
    }

    this.logger.log(`Document ${documentId} finalized (E2E client-side)`);
    return { status: "COMPLETED" };
  }

  /**
   * Get signature data for all signers of a document.
   * Used by the client for E2E finalization (applying visual signatures).
   */
  async getSignaturesForFinalization(documentId: string, userId: string) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId, isE2EEncrypted: true },
      include: {
        recipients: {
          where: { role: "SIGNER", status: "SIGNED" },
          select: {
            id: true,
            name: true,
            email: true,
            signedAt: true,
            signatureData: true,
            signatureType: true,
            order: true,
          },
          orderBy: { order: "asc" },
        },
        fields: {
          include: {
            fieldValues: {
              include: {
                recipient: { select: { name: true, email: true } },
              },
            },
          },
        },
      },
    });

    if (!doc) throw new NotFoundException("Document not found");
    this.assertSourceAvailable(doc);
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException("Document is not awaiting finalization");
    }

    return {
      documentId: doc.id,
      fileName: doc.fileName,
      addApprovalField: doc.addApprovalField,
      addApprovalMention: doc.addApprovalMention,
      addInitials: doc.addInitials,
      initialsPlacement: doc.initialsPlacement,
      initialsIncludeSignaturePage: doc.initialsIncludeSignaturePage,
      signaturePage: doc.signaturePage,
      watermarkPage: doc.watermarkPage,
      signatureLevel: doc.signatureLevel,
      signers: doc.recipients,
      fields: doc.fields,
    };
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
