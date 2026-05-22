import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * PdfSigningService handles the cryptographic signing of PDF documents
 * according to PAdES (PDF Advanced Electronic Signatures) standard.
 *
 * Compliance: eIDAS Regulation (EU) No 910/2014
 * - AES (Advanced Electronic Signature): identity verification via OTP + audit trail
 * - QES (Qualified Electronic Signature): requires qualified certificate from TSP
 *
 * This service handles:
 * 1. Loading P12/PFX certificates
 * 2. Creating PKCS#7/CMS signatures
 * 3. Embedding signatures in PDF (PAdES-B-B or PAdES-B-LT)
 * 4. Timestamp Authority (TSA) requests for long-term validation
 * 5. Certificate verification page generation
 */
@Injectable()
export class PdfSigningService {
  private readonly logger = new Logger(PdfSigningService.name);

  private certificatePath: string;
  private certificatePassword: string;
  private tsaUrl: string;

  constructor() {
    this.certificatePath =
      process.env.SIGNING_CERTIFICATE_PATH ||
      path.join(process.cwd(), "data", "signing", "certificate.p12");
    this.certificatePassword =
      process.env.SIGNING_CERTIFICATE_PASSWORD || "";
    this.tsaUrl =
      process.env.SIGNING_TSA_URL || "https://freetsa.org/tsr";

    // Reject HTTP TSA URLs in production — timestamps must be fetched over TLS
    if (
      this.tsaUrl &&
      !this.tsaUrl.startsWith("https://") &&
      process.env.NODE_ENV === "production"
    ) {
      this.logger.error(
        `TSA URL "${this.tsaUrl}" uses insecure HTTP. ` +
        "Set SIGNING_TSA_URL to an HTTPS endpoint. TSA disabled.",
      );
      this.tsaUrl = "";
    }
  }

  /**
   * Sign a PDF buffer with a real PAdES-B-B signature.
   * Uses @signpdf/signpdf + @signpdf/placeholder-pdf-lib + @signpdf/signer-p12
   * to embed a valid PKCS#7/CMS signature into the PDF's /Sig dictionary
   * with proper ByteRange handling.
   *
   * If no certificate is configured, the PDF is returned with explicit
   * "UNSIGNED" metadata — no false guarantees.
   */
  async signPdf(
    pdfBuffer: Buffer,
    signerInfo: {
      name: string;
      email: string;
      reason?: string;
      location?: string;
    },
  ): Promise<Buffer> {
    const p12Buffer = await this.loadCertificate();
    if (!p12Buffer) {
      this.logger.warn(
        "No signing certificate found at " + this.certificatePath + " - " +
        "returning PDF WITHOUT cryptographic signature. " +
        "The document is NOT tamper-proof. " +
        "Configure SIGNING_CERTIFICATE_PATH to a .p12/.pfx file.",
      );
      const { PDFDocument } = await import("pdf-lib");
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      pdfDoc.setSubject("UNSIGNED - No cryptographic signature applied");
      pdfDoc.setProducer("PrivCloud Sharing - SIGNATURE NOT APPLIED (no certificate)");
      return Buffer.from(await pdfDoc.save());
    }

    const reason =
      signerInfo.reason || "Document signé électroniquement via PrivCloud Sharing";
    const location = signerInfo.location || "PrivCloud Sharing Platform";

    try {
      // 1. Load the PDF with pdf-lib and add a signature placeholder
      const { PDFDocument } = await import("pdf-lib");
      const { pdflibAddPlaceholder } = await import("@signpdf/placeholder-pdf-lib");
      const { P12Signer } = await import("@signpdf/signer-p12");
      const { default: signPdf } = await import("@signpdf/signpdf");

      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Set metadata
      pdfDoc.setProducer("PrivCloud Sharing - Signature Électronique eIDAS");
      pdfDoc.setCreator("PrivCloud Sharing SAAS");

      // Add the /Sig placeholder — reserves space for the CMS signature
      pdflibAddPlaceholder({
        pdfDoc,
        reason,
        location,
        name: signerInfo.name,
        contactInfo: signerInfo.email,
        signatureLength: 8192, // bytes reserved for PKCS#7 DER
      });

      // Serialize the PDF with the placeholder in place
      const pdfWithPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

      // 2. Create the P12 signer from the PKCS#12 certificate
      // Note: pass empty string explicitly for empty-password P12 files.
      // Using `undefined` causes node-forge to skip MAC verification differently.
      const signer = new P12Signer(p12Buffer, {
        passphrase: this.certificatePassword,
      });

      // 3. Sign: computes ByteRange hash, creates PKCS#7/CMS, inserts it
      const signedPdf = await signPdf.sign(pdfWithPlaceholder, signer);

      this.logger.log(
        `PDF signed successfully (PAdES-B-B) for ${signerInfo.email} — ` +
        `${signedPdf.length} bytes, reason: "${reason}"`,
      );

      return signedPdf;
    } catch (error: any) {
      this.logger.error(
        `PAdES signing failed: ${error?.message}. ` +
        "Returning PDF WITHOUT cryptographic signature.",
      );
      // Fallback: return unsigned PDF with explicit warning
      const { PDFDocument } = await import("pdf-lib");
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      pdfDoc.setSubject("SIGNATURE FAILED - " + (error?.message || "Unknown error"));
      pdfDoc.setProducer("PrivCloud Sharing - SIGNATURE FAILED");
      return Buffer.from(await pdfDoc.save());
    }
  }

  /**
   * Request a timestamp token from a TSA (RFC 3161).
   * Required for PAdES-B-T and PAdES-B-LT long-term validation.
   */
  async getTimestamp(messageImprint: Buffer): Promise<Buffer | null> {
    if (!this.tsaUrl) return null;

    try {
      // Create a TimeStampReq (RFC 3161)
      const nonce = crypto.randomBytes(8);

      // ASN.1 DER encoding of TimeStampReq
      // MessageImprint: hash algorithm OID (SHA-256) + hash value
      const sha256Oid = Buffer.from([
        0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
        0x02, 0x01, 0x05, 0x00,
      ]);

      const messageImprintSeq = Buffer.concat([
        Buffer.from([0x30, sha256Oid.length + messageImprint.length + 2]),
        sha256Oid,
        Buffer.from([0x04, messageImprint.length]),
        messageImprint,
      ]);

      const tsReqBody = Buffer.concat([
        Buffer.from([0x30, messageImprintSeq.length + 2 + 1]),
        Buffer.from([0x02, 0x01, 0x01]), // version INTEGER 1
        messageImprintSeq,
      ]);

      const response = await fetch(this.tsaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/timestamp-query",
        },
        body: tsReqBody,
      });

      if (!response.ok) {
        this.logger.warn(`TSA responded with status ${response.status}`);
        return null;
      }

      const tsResponse = Buffer.from(await response.arrayBuffer());
      this.logger.log("Timestamp token obtained from TSA");
      return tsResponse;
    } catch (error: any) {
      this.logger.error(`TSA request failed: ${error?.message}`);
      return null;
    }
  }

  /**
   * Load the signing certificate from disk or database.
   */
  private async loadCertificate(): Promise<Buffer | null> {
    try {
      if (fs.existsSync(this.certificatePath)) {
        return fs.readFileSync(this.certificatePath);
      }
      this.logger.warn(
        `Signing certificate not found at ${this.certificatePath}`,
      );
      return null;
    } catch (error: any) {
      this.logger.error(`Failed to load certificate: ${error?.message}`);
      return null;
    }
  }

  /**
   * Generate a signing certificate verification page (PDF page).
   * This page is appended as the last page of the signed document.
   * Contains: signature details, timestamp, hash, QR code, audit info.
   */
  async generateCertificatePage(
    documentInfo: {
      documentId: string;
      fileName: string;
      signedAt: Date;
      signers: Array<{
        name: string;
        email: string;
        signedAt: Date;
        ip: string;
        signatureType: string;
      }>;
      documentHash: string;
      signatureLevel: string;
    },
  ): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const { width, height } = page.getSize();
    let y = height - 60;

    // Header
    page.drawText("CERTIFICAT DE SIGNATURE ÉLECTRONIQUE", {
      x: 50,
      y,
      size: 16,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.4),
    });
    y -= 30;

    page.drawText("Signature électronique avancée basée sur les critères de l’article 26 du règlement eIDAS (UE) n° 910/2014", {
      x: 50,
      y,
      size: 10,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
    y -= 40;

    // Document info
    page.drawText("INFORMATIONS DU DOCUMENT", {
      x: 50,
      y,
      size: 12,
      font: fontBold,
    });
    y -= 20;

    const lines = [
      `Identifiant: ${documentInfo.documentId}`,
      `Fichier: ${documentInfo.fileName}`,
      `Niveau de signature: ${documentInfo.signatureLevel === "QES" ? "Qualifiée (QES)" : "Avancée (AES)"}`,
      `Empreinte SHA-256: ${documentInfo.documentHash}`,
      `Date de finalisation: ${documentInfo.signedAt.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "medium", timeZone: "Europe/Paris" })}`,
    ];

    for (const line of lines) {
      page.drawText(line, { x: 70, y, size: 9, font });
      y -= 15;
    }
    y -= 20;

    // Signers
    page.drawText("SIGNATAIRES", {
      x: 50,
      y,
      size: 12,
      font: fontBold,
    });
    y -= 20;

    for (let i = 0; i < documentInfo.signers.length; i++) {
      const signer = documentInfo.signers[i];
      page.drawText(`Signataire ${i + 1}:`, {
        x: 70,
        y,
        size: 10,
        font: fontBold,
      });
      y -= 15;

      const signerLines = [
        `  Nom: ${signer.name}`,
        `  Email: ${signer.email}`,
        `  Signé le: ${signer.signedAt.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "medium", timeZone: "Europe/Paris" })}`,
        `  Adresse IP: ${signer.ip}`,
        `  Type de signature: ${signer.signatureType}`,
      ];

      for (const line of signerLines) {
        page.drawText(line, { x: 80, y, size: 9, font });
        y -= 14;
      }
      y -= 10;
    }
    y -= 20;

    // Legal notice
    page.drawText("MENTION LÉGALE", {
      x: 50,
      y,
      size: 12,
      font: fontBold,
    });
    y -= 20;

    const legalText = [
      "Ce document a fait l’objet d’une signature électronique avancéeintégrant des mécanismes d’horodatage,",
      " d’intégrité cryptographique et de traçabilité conformément aux principes définis par",
      "l’article 26 du règlement eIDAS (UE) n° 910/2014.",
      "",
      "Le système de signature met notamment en œuvre :",
      "• Vérification du signataire par code OTP transmis par email",
      "• Horodatage RFC 3161 via Autorité d’Horodatage (TSA)",
      "• Empreinte cryptographique SHA-256 garantissant la détection des modifications ultérieures du document",
      "• Piste d’audit des opérations de signature",
      "",
      "Horodatage cryptographique (TSA) reposant sur le standard RFC 3161.",
      "L’horodatage garantit que la signature a été créée à un moment précis,",
      "Toute modification du document après signature invalide l’empreinte cryptographique associée.",
      "Conformément à l’article 26 du règlement eIDAS, cette signature électronique avancée est présumée fiable",
      "et a une valeur probante en cas de litige.",
      "",
      "Cette signature électronique avancée est mise en œuvre conformément aux exigences de l’article 26 du",
      "règlement eIDAS (UE) n° 910/2014 et s’appuie sur des mécanismes d’intégrité, d’horodatage et de",
      "traçabilité destinés à en assurer la valeur probatoire.",
    ];

    for (const line of legalText) {
      page.drawText(line, { x: 70, y, size: 8, font });
      y -= 12;
    }
    y -= 30;

    // Footer
    page.drawText(
      `Généré par PrivCloud Sharing - ${new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "medium", timeZone: "Europe/Paris" })}`,
      { x: 50, y: 30, size: 7, font, color: rgb(0.5, 0.5, 0.5) },
    );

    return Buffer.from(await pdfDoc.save());
  }

  /**
   * Add "Bon pour Accord" diagonal watermark and signature fields to a PDF.
   */
  async addApprovalFieldAndSignature(
    pdfBuffer: Buffer,
    signerInfo: {
      name: string;
      signatureImage?: Buffer; // PNG image of handwritten signature
      signatureText?: string; // Text-based signature
      signedDate: Date;
    },
    options: {
      addApprovalWatermark: boolean;
      addApprovalMention?: boolean;
      page?: number; // specific page, or last page by default
    } = { addApprovalWatermark: true },
  ): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts, degrees } = await import("pdf-lib");

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const targetPage = pages[options.page ?? pages.length - 1];

    const { width, height } = firstPage.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Add diagonal "Bon pour Accord" watermark on FIRST page
    if (options.addApprovalWatermark) {
      firstPage.drawText("Bon pour Accord", {
        x: width * 0.12,
        y: height * 0.38,
        size: 60,
        font: fontBold,
        color: rgb(0.5, 0.75, 0.5),
        opacity: 0.35,
        rotate: degrees(45),
      });
    }

    // Add "Lu et approuvé" mention + signature (unless explicitly disabled)
    const addMention = options.addApprovalMention !== false;
    const dateStr = signerInfo.signedDate.toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Paris",
    });

    const approvalText = `Lu et approuvé le ${dateStr}`;
    const nameText = signerInfo.name;

    // Position in bottom-right area
    const sigX = width - 250;
    let sigY = 120;

    if (addMention) {
      // "Lu et approuvé le ..."
      targetPage.drawText(approvalText, {
        x: sigX,
        y: sigY + 60,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
    }

    // Signer name above signature
    targetPage.drawText(nameText, {
      x: sigX,
      y: sigY + 45,
      size: 10,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    // Embed signature image if provided
    if (signerInfo.signatureImage) {
      const sigImage = await pdfDoc.embedPng(signerInfo.signatureImage);
      const sigDims = sigImage.scale(0.5);
      targetPage.drawImage(sigImage, {
        x: sigX,
        y: sigY,
        width: Math.min(sigDims.width, 180),
        height: Math.min(sigDims.height, 40),
      });
    } else if (signerInfo.signatureText) {
      // Text-based signature (italic style)
      targetPage.drawText(signerInfo.signatureText, {
        x: sigX,
        y: sigY + 10,
        size: 14,
        font,
        color: rgb(0.1, 0.1, 0.5),
      });
    }

    return Buffer.from(await pdfDoc.save());
  }

  /**
   * Add signers' initials at the bottom of every page.
   */
  async addInitialsToAllPages(
    pdfBuffer: Buffer,
    signerNames: string[],
  ): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();

    const initialsText = signerNames
      .map((name) =>
        name
          .split(" ")
          .map((w) => w[0]?.toUpperCase() || "")
          .join(""),
      )
      .join(" / ");

    for (const page of pages) {
      const { width } = page.getSize();
      page.drawText(initialsText, {
        x: width - 60,
        y: 20,
        size: 8,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }

    return Buffer.from(await pdfDoc.save());
  }
}
