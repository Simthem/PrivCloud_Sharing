import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { EmailService } from "src/email/email.service";
import { FileService } from "src/file/file.service";
import { ConfigService } from "src/config/config.service";
import { PdfSigningService } from "./pdf-signing.service";

@Injectable()
export class SigningE2EService {
  private readonly logger = new Logger(SigningE2EService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private fileService: FileService,
    private configService: ConfigService,
    private pdfSigningService: PdfSigningService,
  ) {}

  /**
   * E2E Step 1: Apply certificate page + cryptographic PAdES signature.
   * The client sends the decrypted PDF (with visual signatures already applied).
   * We add the eIDAS certificate page, apply PAdES crypto signature, and
   * return the signed PDF (in clear) so the client can re-encrypt it.
   * The PDF is NOT stored - only returned.
   */
  async signE2EPdf(documentId: string, userId: string, plaintextPdfBuffer: Buffer): Promise<Buffer> {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
      include: { recipients: { where: { role: "SIGNER" } } },
    });

    if (!doc) throw new NotFoundException("Document not found");
    if (!doc.isE2EEncrypted) throw new BadRequestException("Not an E2E document");
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException(
        `Document status is "${doc.status}", expected "AWAITING_FINALIZATION"`,
      );
    }

    const allSigned = doc.recipients.every((r) => r.status === "SIGNED");
    if (!allSigned) {
      throw new BadRequestException("Not all signers have signed yet");
    }

    this.logger.log(`E2E signE2EPdf: applying certificate page + PAdES for ${documentId}`);

    let pdfBuffer = plaintextPdfBuffer;

    // Generate and append certificate page
    const documentHash = crypto
      .createHash("sha256")
      .update(pdfBuffer)
      .digest("hex");

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
      })),
      documentHash,
      signatureLevel: doc.signatureLevel,
    });

    const { PDFDocument } = await import("pdf-lib");
    const mainDoc = await PDFDocument.load(pdfBuffer);
    const certDoc = await PDFDocument.load(certPage);
    const [certPageCopy] = await mainDoc.copyPages(certDoc, [0]);
    mainDoc.addPage(certPageCopy);
    pdfBuffer = Buffer.from(await mainDoc.save());

    // Apply cryptographic PAdES signature
    pdfBuffer = await this.pdfSigningService.signPdf(pdfBuffer, {
      name: "PrivCloud Sharing",
      email: "signing@privcloud.eu",
      reason: "Signature électronique eIDAS (E2E) - Tous les signataires ont signé",
    });

    this.logger.log(`E2E signE2EPdf: PDF signed (${pdfBuffer.length} bytes) for ${documentId}`);
    return pdfBuffer;
  }

  /**
   * E2E Step 2: Store the re-encrypted signed PDF and mark COMPLETED.
   * The client re-encrypts the PAdES-signed PDF and sends it here for storage.
   */
  async storeE2EFinal(documentId: string, userId: string, encryptedPdfBuffer: Buffer) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
      include: { recipients: { where: { role: "SIGNER" } } },
    });

    if (!doc) throw new NotFoundException("Document not found");
    if (!doc.isE2EEncrypted) throw new BadRequestException("Not an E2E document");
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException(
        `Document status is "${doc.status}", expected "AWAITING_FINALIZATION"`,
      );
    }

    const allSigned = doc.recipients.every((r) => r.status === "SIGNED");
    if (!allSigned) {
      throw new BadRequestException("Not all signers have signed yet");
    }

    // Store the re-encrypted signed PDF
    const signedKey = `signed/${documentId}/${doc.fileName}`;
    await this.fileService.storeFileByKey(signedKey, encryptedPdfBuffer);

    await this.prisma.signatureDocument.update({
      where: { id: documentId },
      data: { status: "COMPLETED", signedFileKey: signedKey },
    });

    await this.createAuditEvent(documentId, "COMPLETED", "client-e2e");

    // Log team activity
    if (doc.teamId) {
      this.logger.log(`Logging SIGNATURE_COMPLETE (E2E) for team ${doc.teamId}`);
      this.prisma.teamAccessLog.create({
        data: {
          teamId: doc.teamId,
          action: "SIGNATURE_COMPLETE",
          actorEmail: "system",
          actorName: "Finalisation E2E client",
          fileName: doc.fileName,
        },
      }).catch(err => this.logger.error(`Failed to log SIGNATURE_COMPLETE (E2E): ${err.message}`));
    }

    // Notify all parties
    const allRecipients = await this.prisma.signatureRecipient.findMany({
      where: { documentId },
    });

    const baseUrl = await this.configService.get("general.appUrl");
    const documentUrl = `${baseUrl}/signing/${documentId}`;
    const signersList = allRecipients
      .filter(r => r.role === "SIGNER")
      .map(r => `  • ${r.name} (${r.email}) - signé le ${r.signedAt ? new Date(r.signedAt).toLocaleDateString("fr-FR") : "N/A"}`)
      .join("\n");

    for (const r of allRecipients) {
      const hasAccount = r.userId != null;
      await this.emailService.sendMail(
        r.email,
        `Document signé - ${doc.fileName}`,
        `Bonjour ${r.name},\n\n` +
          `Le document "${doc.fileName}" a été signé par tous les signataires et la signature cryptographique PAdES a été appliquée.\n\n` +
          `Signataires :\n${signersList}\n\n` +
          (hasAccount
            ? `Vous pouvez consulter et télécharger le document signé depuis votre espace :\n${documentUrl}\n\n` +
              `Ce document apparaît également dans votre rubrique "Documents reçus" de l'onglet Signature.\n\n`
            : `Si vous avez un compte PrivCloud Sharing, connectez-vous pour retrouver ce document dans vos "Documents reçus".\n\n`) +
          `-- \nPrivCloud Sharing - Signature Électronique`,
      );
    }

    // Notify creator
    const creator = await this.prisma.user.findUnique({ where: { id: userId } });
    if (creator) {
      await this.emailService.sendMail(
        creator.email,
        `Document finalisé - ${doc.fileName}`,
        `Bonjour ${creator.username || ""},\n\n` +
          `Votre document "${doc.fileName}" a été signé par tous les signataires et finalisé avec succès.\n\n` +
          `Signataires :\n${signersList}\n\n` +
          `La signature cryptographique PAdES a été appliquée.\n\n` +
          `Consultez et téléchargez le document signé ici :\n${documentUrl}\n\n` +
          (doc.teamId ? `Ce document est également visible dans l'espace de votre équipe.\n\n` : "") +
          `-- \nPrivCloud Sharing - Signature Électronique`,
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
    if (doc.status !== "AWAITING_FINALIZATION") {
      throw new BadRequestException("Document is not awaiting finalization");
    }

    return {
      documentId: doc.id,
      fileName: doc.fileName,
      addApprovalField: doc.addApprovalField,
      addApprovalMention: doc.addApprovalMention,
      addInitials: doc.addInitials,
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
    await this.prisma.signatureAuditEvent.create({
      data: { documentId, eventType, actor, ipAddress, userAgent, metadata },
    });
  }
}
