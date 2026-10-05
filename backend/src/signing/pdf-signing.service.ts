import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import {
  getInitialsStampGeometry,
  shouldAddInitialsToPage,
} from "./initials-placement.util";
import {
  normalizedPdfRotation,
  rawPdfBoxToVisual,
  visualPageSize,
  visualPdfPointToRaw,
} from "./pdf-rotation.util";
import {
  defaultSignatureSlotPosition,
  fitSignatureImage,
} from "./signature-slots.util";
import { pdfSafeText } from "./pdf-text.util";
import { parseSignatureData, SignatureVisual } from "./signature-data.util";
import { consentSha256For } from "./signing-evidence.util";
import {
  asn1,
  Asn1Node,
  Asn1Type,
  children,
  encodeDer,
  isContext,
  isUniversal,
  ParsedCertificate,
  parseCertificate,
  parseDer,
  parseDerPrefix,
  readOctets,
  readOid,
  readSmallInteger,
  readTime,
} from "./asn1-der.util";
import { readPkcs12 } from "./pkcs12.util";
import type { PDFDocument } from "pdf-lib";

/**
 * PdfSigningService handles the cryptographic signing of PDF documents
 * using an embedded CMS/PDF signature and, when configured, a validated
 * RFC 3161 signature time-stamp token.
 * The platform certificate protects the finalized evidence file; it is not a
 * qualified certificate issued to an individual signer.
 *
 * This service handles:
 * 1. Loading P12/PFX certificates
 * 2. Creating PKCS#7/CMS signatures
 * 3. Embedding signatures in PDF (PAdES-B-B or PAdES-B-T)
 * 4. RFC 3161 TSA requests containing only a SHA-256 message imprint
 * 5. Validation and CMS embedding of the returned TimeStampToken
 * 6. Certificate verification page generation
 */

/** Seal a timestamp belongs to, recorded with its raw RFC 3161 exchange. */
export type TimestampContext = {
  scope: "pdf-seal" | "attestation" | "forensic" | "enrollment";
  documentId?: string;
  webauthnCredentialId?: string;
};
@Injectable()
export class PdfSigningService implements OnModuleInit {
  private readonly logger = new Logger(PdfSigningService.name);

  private certificatePath: string;
  private certificatePassword: string;
  private tsaUrls: string[];
  private readonly tsaRequired: boolean;
  private readonly tsaPolicyOid?: string;
  private readonly tsaTrustedCertFingerprints: Set<string>;

  constructor(@Optional() private readonly prisma?: PrismaService) {
    this.certificatePath =
      process.env.SIGNING_CERTIFICATE_PATH ||
      path.join(process.cwd(), "data", "signing", "certificate.p12");
    this.certificatePassword = process.env.SIGNING_CERTIFICATE_PASSWORD || "";

    // No implicit public TSA: production must deliberately select the exact
    // service (and, separately, establish its eIDAS qualification if claimed).
    const primary = process.env.SIGNING_TSA_URL || "";
    const fallback1 = process.env.SIGNING_TSA_URL_FALLBACK_1 || "";
    const fallback2 = process.env.SIGNING_TSA_URL_FALLBACK_2 || "";

    this.tsaUrls = [primary, fallback1, fallback2]
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    this.tsaRequired =
      this.tsaUrls.length > 0 &&
      process.env.SIGNING_TSA_REQUIRED?.trim().toLowerCase() !== "false";
    this.tsaPolicyOid = process.env.SIGNING_TSA_POLICY_OID?.trim() || undefined;
    if (this.tsaPolicyOid && !/^[0-9]+(?:\.[0-9]+)+$/.test(this.tsaPolicyOid)) {
      throw new Error("SIGNING_TSA_POLICY_OID must be a dotted-decimal OID");
    }
    this.tsaTrustedCertFingerprints = new Set(
      (process.env.SIGNING_TSA_TRUSTED_CERT_SHA256 || "")
        .split(",")
        .map((fingerprint) =>
          fingerprint.replace(/:/g, "").trim().toLowerCase(),
        )
        .filter((fingerprint) => fingerprint.length > 0),
    );
    for (const fingerprint of this.tsaTrustedCertFingerprints) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw new Error(
          "SIGNING_TSA_TRUSTED_CERT_SHA256 must contain comma-separated SHA-256 fingerprints",
        );
      }
    }
    if (
      process.env.NODE_ENV === "production" &&
      this.tsaUrls.length > 0 &&
      this.tsaTrustedCertFingerprints.size === 0
    ) {
      throw new Error(
        "Production RFC 3161 timestamping requires SIGNING_TSA_TRUSTED_CERT_SHA256",
      );
    }

    if (this.tsaUrls.length > 0) {
      this.logger.log(
        `TSA configured: ${this.tsaUrls[0]}` +
          (this.tsaUrls.length > 1
            ? ` (+${this.tsaUrls.length - 1} fallback)`
            : "") +
          (this.tsaRequired ? " (validated timestamp required)" : ""),
      );
      if (this.tsaTrustedCertFingerprints.size === 0) {
        this.logger.warn(
          "No TSA trust fingerprint configured; acceptable only outside production",
        );
      }
    }
  }

  /**
   * Report at startup a seal file the signing path would refuse, such as a
   * P12 still protected by the legacy SHA-1 schemes, instead of failing at
   * the first signature. Startup itself is never blocked.
   */
  onModuleInit() {
    if (!fs.existsSync(this.certificatePath)) return;
    try {
      readPkcs12(
        fs.readFileSync(this.certificatePath),
        this.certificatePassword,
      );
    } catch {
      this.logger.error(
        `Signing certificate ${this.certificatePath} cannot be used: it needs ` +
          "PBES2 AES with a SHA-256 MAC and the configured password. " +
          "Re-export it with scripts/convert-signing-p12.sh.",
      );
    }
  }

  /**
   * Sign a PDF buffer with a PAdES-B-B signature and upgrade it to PAdES-B-T
   * when an RFC 3161 signature time-stamp token is configured and validated.
   * Uses @signpdf/placeholder-pdf-lib for the /Sig placeholder, then builds
   * a full CMS/PKCS#7 SignedData manually (node:crypto signature) with:
   * - signingCertificateV2 (OID 1.2.840.113549.1.9.16.2.47) in signed attributes
   * - Full certificate chain from the P12
   * - Proper ByteRange handling and ETSI.CAdES.detached SubFilter
   *
   * If no signing certificate is configured, the operation fails closed:
   * no unsigned document is ever presented as a finalized signature.
   */
  async signPdf(
    pdfBuffer: Buffer,
    signerInfo: {
      name: string;
      email: string;
      reason?: string;
      location?: string;
    },
    timestampContext?: TimestampContext,
  ): Promise<Buffer> {
    const p12Buffer = await this.loadCertificate();
    if (!p12Buffer) {
      // SECURITY: Fail-closed - refuse to produce a document without crypto signature
      const msg =
        "No signing certificate found at " +
        this.certificatePath +
        ". " +
        "Cannot produce a cryptographically signed PDF. " +
        "Configure SIGNING_CERTIFICATE_PATH to a .p12/.pfx file.";
      this.logger.error(msg);
      throw new Error(msg);
    }

    const reason =
      signerInfo.reason ||
      "Document electronically signed with PrivCloud Sharing";
    const location = signerInfo.location || "PrivCloud Sharing Platform";

    try {
      // 1. Load the PDF with pdf-lib and add a signature placeholder
      const { PDFDocument } = await import("pdf-lib");
      const { pdflibAddPlaceholder } =
        await import("@signpdf/placeholder-pdf-lib");

      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Set metadata
      pdfDoc.setProducer("PrivCloud Sharing - PAdES electronic signature");
      pdfDoc.setCreator("PrivCloud Sharing");

      // Add the /Sig placeholder - signatureLength is in hex chars (2 per byte)
      // 32768 hex chars = 16384 bytes capacity for CMS + TSA timestamp token
      pdflibAddPlaceholder({
        pdfDoc,
        reason,
        location,
        name: signerInfo.name,
        contactInfo: signerInfo.email,
        signatureLength: 32768,
        subFilter: "ETSI.CAdES.detached",
      });

      // Serialize the PDF with the placeholder in place
      const pdfWithPlaceholder = Buffer.from(
        await pdfDoc.save({ useObjectStreams: false }),
      );

      // 2. Build PAdES-compliant CMS with proper ByteRange handling
      let signedPdf = this.signPdfWithPadesCms(pdfWithPlaceholder, p12Buffer);

      // 3. Embed RFC 3161 timestamp into the CMS (PAdES-B-B -> PAdES-B-T)
      if (this.tsaUrls.length > 0) {
        try {
          signedPdf = await this.embedTimestampInSignedPdf(
            signedPdf,
            timestampContext,
          );
          this.logger.log(
            `PDF signed with timestamp (PAdES-B-T): ${signedPdf.length} bytes`,
          );
        } catch (tsaError: any) {
          if (this.tsaRequired) throw tsaError;
          this.logger.warn(
            "TSA timestamp embedding failed; SIGNING_TSA_REQUIRED=false: PDF remains PAdES-B-B without timestamp.",
          );
        }
      } else {
        this.logger.log(
          `PDF signed (PAdES-B-B, no TSA configured): ${signedPdf.length} bytes`,
        );
      }

      return signedPdf;
    } catch {
      // SECURITY: Fail-closed - do NOT return an unsigned PDF that would be
      // marked as COMPLETED by the caller. Let the caller handle the failure.
      this.logger.error("PAdES signing failed");
      throw new Error("PAdES signing failed");
    }
  }

  /**
   * Create a detached PAdES CMS signature for a SHA-256 PDF ByteRange digest.
   * The PDF stays client-side: only its 32-byte digest reaches this service.
   */
  async signDigest(
    messageDigest: Buffer,
    timestampContext?: TimestampContext,
  ): Promise<Buffer> {
    if (messageDigest.length !== 32) {
      throw new Error("PAdES signing requires a 32-byte SHA-256 digest");
    }

    const p12Buffer = await this.loadCertificate();
    if (!p12Buffer) {
      const msg =
        "No signing certificate found at " +
        this.certificatePath +
        ". " +
        "Cannot produce a cryptographic signature.";
      this.logger.error(msg);
      throw new Error(msg);
    }

    try {
      let cmsDer = this.buildPadesCms(messageDigest, p12Buffer);

      if (this.tsaUrls.length > 0) {
        try {
          cmsDer = await this.embedTimestampInCms(cmsDer, timestampContext);
          this.logger.log(
            `Detached PAdES-B-T CMS created (${cmsDer.length} bytes)`,
          );
        } catch (tsaError: any) {
          if (this.tsaRequired) throw tsaError;
          this.logger.warn(
            "TSA timestamp embedding failed; SIGNING_TSA_REQUIRED=false: CMS remains PAdES-B-B without timestamp.",
          );
        }
      }

      return cmsDer;
    } catch {
      this.logger.error("Detached PAdES signing failed");
      throw new Error("Detached PAdES signing failed");
    }
  }

  /**
   * Build a PAdES-compliant CMS/PKCS#7 signature and embed it into the PDF.
   *
   * Handles ByteRange calculation directly (finds /Contents placeholder position,
   * computes byte offsets, fills in /ByteRange, then signs).
   *
   * Includes:
   * - signingCertificateV2 (OID 1.2.840.113549.1.9.16.2.47) in signed attributes
   * - Full certificate chain in the CMS certificates field
   * - content-type, message-digest, signing-time signed attributes
   *
   * Required for the PAdES baseline CMS structure used here.
   */
  private signPdfWithPadesCms(
    pdfWithPlaceholder: Buffer,
    p12Buffer: Buffer,
  ): Buffer {
    // --- Step 1: Find the signature hex placeholder position ---
    // @signpdf/placeholder-pdf-lib writes: PDFHexString.of(String.fromCharCode(0).repeat(signatureLength))
    // This means the PDF contains <\x00\x00\x00...\x00> (NULL bytes, NOT ASCII '0' chars).
    const pdfStr = pdfWithPlaceholder.toString("latin1");

    // Find the large null-byte block between angle brackets (the signature placeholder).
    // \x00 matches the NULL byte that @signpdf/placeholder-pdf-lib writes.
    const placeholderMatch = pdfStr.match(/<(\x00{1000,})>/);
    if (!placeholderMatch) {
      throw new Error(
        "Cannot find signature hex placeholder in PDF. " +
          "Ensure pdflibAddPlaceholder was called with signatureLength >= 500.",
      );
    }

    // Position of '<' in the PDF
    const angleBracketOpen = pdfStr.indexOf(placeholderMatch[0]);
    // The full match includes '<...>', so '>' is at angleBracketOpen + fullMatch.length - 1
    const angleBracketClose = angleBracketOpen + placeholderMatch[0].length - 1;
    // The writeable slot is everything between < and > (null bytes we'll overwrite with hex)
    const slotLength = angleBracketClose - angleBracketOpen - 1;

    // --- Step 2: Calculate actual ByteRange values ---
    // ByteRange = [offset1, length1, offset2, length2]
    // offset1=0, length1=bytes before '<', offset2=byte after '>', length2=remaining bytes
    const afterCloseBracket = angleBracketClose + 1; // position right after '>'
    const byteRange = [
      0,
      angleBracketOpen,
      afterCloseBracket,
      pdfWithPlaceholder.length - afterCloseBracket,
    ];

    // --- Step 3: Fill in /ByteRange placeholder with actual values ---
    // Find the ByteRange placeholder pattern (asterisks or any placeholder)
    const byteRangePlaceholder = pdfStr.match(/\/ByteRange\s*\[([^\]]+)\]/);
    if (!byteRangePlaceholder) {
      throw new Error("Cannot find /ByteRange placeholder in PDF");
    }

    const byteRangeFullMatch = byteRangePlaceholder[0]; // e.g. "/ByteRange [0 /********** /********** /**********]"
    const byteRangeInnerContent = byteRangePlaceholder[1]; // content between [ and ]
    const byteRangeStart = pdfStr.indexOf(byteRangeFullMatch);

    // Build replacement string: actual values, space-padded to exact same byte length
    const byteRangeValues = byteRange.join(" ");
    const innerPadded = byteRangeValues.padEnd(
      byteRangeInnerContent.length,
      " ",
    );
    const byteRangeReplacement = `/ByteRange [${innerPadded}]`;

    // Verify same byte length (critical - positions must not shift)
    if (byteRangeReplacement.length !== byteRangeFullMatch.length) {
      throw new Error(
        `ByteRange replacement length mismatch: ${byteRangeReplacement.length} vs ${byteRangeFullMatch.length}`,
      );
    }

    // Patch ByteRange into the PDF buffer
    const pdfBuf = Buffer.from(pdfWithPlaceholder);
    pdfBuf.write(
      byteRangeReplacement,
      byteRangeStart,
      byteRangeReplacement.length,
      "latin1",
    );

    // --- Step 4: Extract data to sign (everything except the hex content between < >) ---
    const dataToSign = Buffer.concat([
      pdfBuf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      pdfBuf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);

    // --- Step 5: Compute message digest ---
    const messageDigest = crypto
      .createHash("sha256")
      .update(dataToSign)
      .digest();

    // --- Step 6: Build the detached CMS and patch it into the PDF ---
    const cmsDer = this.buildPadesCms(messageDigest, p12Buffer);
    const maxCmsBytes = slotLength / 2; // slot is in hex chars, 2 hex chars = 1 byte

    if (cmsDer.length > maxCmsBytes) {
      throw new Error(
        `CMS signature (${cmsDer.length} bytes) exceeds placeholder (${maxCmsBytes} bytes)`,
      );
    }

    // Hex-encode and zero-pad to fill the exact slot between '<' and '>'
    const cmsHex = cmsDer.toString("hex").padEnd(slotLength, "0");

    // Patch CMS hex into the PDF at the position after '<'
    pdfBuf.write(cmsHex, angleBracketOpen + 1, cmsHex.length, "latin1");

    return pdfBuf;
  }

  /** Build a detached CMS/PKCS#7 SignedData from a SHA-256 content digest. */
  private buildPadesCms(messageDigest: Buffer, p12Buffer: Buffer): Buffer {
    const { privateKey, certificates } = readPkcs12(
      p12Buffer,
      this.certificatePassword,
    );
    if (!privateKey) {
      throw new Error("No private key found in P12 certificate");
    }
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("The P12 signing key must be an RSA key");
    }
    if (certificates.length === 0) {
      throw new Error("No certificates found in P12 file");
    }

    const signingCert = certificates.find((cert) => {
      try {
        return cert.x509.checkPrivateKey(privateKey);
      } catch {
        return false;
      }
    });
    if (!signingCert) {
      throw new Error(
        "Cannot identify signing certificate matching private key",
      );
    }

    const chainCerts = this.buildCertChain(signingCert, certificates);
    const commonName = signingCert.x509.subject.match(/^CN=(.*)$/m)?.[1];
    this.logger.log(
      `P12 loaded: signing cert "${commonName}", ` +
        `chain depth: ${chainCerts.length}`,
    );

    const certHash = crypto
      .createHash("sha256")
      .update(signingCert.der)
      .digest();

    // ESSCertIDv2 with the SHA-256 algorithm written out, and IssuerSerial
    // pointing at the signing certificate.
    const essCertIdV2 = asn1.sequence([
      asn1.algorithm("2.16.840.1.101.3.4.2.1"),
      asn1.octetString(certHash),
      asn1.sequence([
        asn1.sequence([asn1.context(4, [signingCert.issuer])]),
        asn1.integer(signingCert.serial),
      ]),
    ]);
    const signingCertificateV2Value = asn1.sequence([
      asn1.sequence([essCertIdV2]),
    ]);

    const attribute = (oid: string, value: Asn1Node) =>
      asn1.sequence([asn1.oid(oid), asn1.set([value])]);
    const signedAttributes = [
      attribute("1.2.840.113549.1.9.3", asn1.oid("1.2.840.113549.1.7.1")),
      attribute("1.2.840.113549.1.9.5", asn1.utcTime(new Date())),
      attribute("1.2.840.113549.1.9.4", asn1.octetString(messageDigest)),
      attribute("1.2.840.113549.1.9.16.2.47", signingCertificateV2Value),
    ];

    // The signature covers the attributes encoded as a SET (RFC 5652 5.4).
    const signedAttrsDer = encodeDer(asn1.set(signedAttributes));
    const signature = crypto.sign("sha256", signedAttrsDer, privateKey);

    const signerInfo = asn1.sequence([
      asn1.integer(1),
      asn1.sequence([signingCert.issuer, asn1.integer(signingCert.serial)]),
      asn1.algorithm("2.16.840.1.101.3.4.2.1"),
      asn1.context(0, signedAttributes),
      asn1.algorithm("1.2.840.113549.1.1.11"),
      asn1.octetString(signature),
    ]);

    const signedData = asn1.sequence([
      asn1.integer(1),
      asn1.set([asn1.algorithm("2.16.840.1.101.3.4.2.1")]),
      asn1.sequence([asn1.oid("1.2.840.113549.1.7.1")]),
      asn1.context(
        0,
        chainCerts.map((cert) => parseDer(cert.der)),
      ),
      asn1.set([signerInfo]),
    ]);

    return encodeDer(
      asn1.sequence([
        asn1.oid("1.2.840.113549.1.7.2"),
        asn1.context(0, [signedData]),
      ]),
    );
  }

  /**
   * Build an ordered certificate chain from signingCert up to root.
   * Returns [signingCert, intermediate(s)..., root] if available.
   */
  private buildCertChain(
    signingCert: ParsedCertificate,
    allCerts: ParsedCertificate[],
  ): ParsedCertificate[] {
    const chain: ParsedCertificate[] = [signingCert];
    const maxDepth = 10;

    let current = signingCert;
    for (let i = 0; i < maxDepth; i++) {
      // Find issuer of current cert
      const issuer = allCerts.find(
        (c) =>
          c !== current &&
          c.subjectDer.equals(current.issuerDer) &&
          !chain.includes(c),
      );
      if (!issuer) break;
      chain.push(issuer);
      // Self-signed root = stop
      if (issuer.subjectDer.equals(issuer.issuerDer)) break;
      current = issuer;
    }

    return chain;
  }

  /**
   * Post-process a signed PDF to embed an RFC 3161 timestamp token
   * as an unsigned attribute in the CMS/PKCS#7 signature.
   *
   * This upgrades the signature from PAdES-B-B to PAdES-B-T.
   *
   * Process:
   * 1. Extract the hex-encoded CMS from the PDF /Contents
   * 2. Parse the DER-encoded CMS (PKCS#7 SignedData)
   * 3. Hash the SignerInfo.encryptedDigest (the signature value)
   * 4. Request a timestamp token from the TSA
   * 5. Add the token as unsigned attribute (OID 1.2.840.113549.1.9.16.2.14)
   * 6. Re-encode and patch back into the PDF
   */
  private async embedTimestampInSignedPdf(
    signedPdf: Buffer,
    timestampContext?: TimestampContext,
  ): Promise<Buffer> {
    // 1. Find the hex-encoded signature in the PDF
    // The signature is between angle brackets: /Contents <HEX...>
    const pdfStr = signedPdf.toString("latin1");
    const contentsMatch = pdfStr.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
    if (!contentsMatch) {
      throw new Error("Cannot find /Contents hex string in signed PDF");
    }

    const hexSignature = contentsMatch[1];
    const contentsStart = pdfStr.indexOf("<" + hexSignature + ">") + 1;
    const _contentsEnd = contentsStart + hexSignature.length;

    // 2. Decode hex -> DER and use the outer ASN.1 length to separate the
    // CMS from placeholder padding. Trimming 0x00 bytes would be unsafe: a
    // legitimate signature value may itself end with 0x00.
    const derWithPadding = Buffer.from(hexSignature, "hex");
    const { length: cmsLength } = parseDerPrefix(derWithPadding);
    if (cmsLength <= 0) throw new Error("Empty CMS in PDF /Contents");
    const derCms = derWithPadding.subarray(0, cmsLength);

    const modifiedDer = await this.embedTimestampInCms(
      derCms,
      timestampContext,
    );

    // Verify it fits in the placeholder
    const maxSize = hexSignature.length / 2; // original placeholder size in bytes
    if (modifiedDer.length > maxSize) {
      throw new Error(
        `Timestamped CMS (${modifiedDer.length} bytes) exceeds placeholder (${maxSize} bytes)`,
      );
    }

    // 10. Hex-encode with zero-padding to fill the placeholder
    const modifiedHex = modifiedDer
      .toString("hex")
      .padEnd(hexSignature.length, "0");

    // 11. Patch the PDF buffer
    const result = Buffer.from(signedPdf);
    result.write(modifiedHex, contentsStart, modifiedHex.length, "latin1");

    this.logger.log(
      `Timestamp embedded successfully (CMS: ${modifiedDer.length} bytes, ` +
        `placeholder: ${maxSize} bytes)`,
    );

    return result;
  }

  /** Add an RFC 3161 timestamp unsigned attribute to a detached CMS. */
  private async embedTimestampInCms(
    derCms: Buffer,
    timestampContext?: TimestampContext,
  ): Promise<Buffer> {
    const contentInfo = parseDer(derCms);
    const signedData = children(children(contentInfo)[1])[0];
    const signerInfos = children(signedData);
    const signerInfo = children(signerInfos[signerInfos.length - 1])[0];
    const signerInfoFields = children(signerInfo);

    const signatureValue = signerInfoFields.find(
      (item, index) => index >= 4 && isUniversal(item, Asn1Type.OCTETSTRING),
    );
    if (!signatureValue) {
      throw new Error("Cannot find signature value in CMS SignerInfo");
    }

    const signatureBytes = readOctets(signatureValue);
    const messageImprint = crypto
      .createHash("sha256")
      .update(signatureBytes)
      .digest();
    const tsaResponse = await this.getTimestamp(
      messageImprint,
      timestampContext,
    );
    if (!tsaResponse) {
      throw new Error("TSA returned no response");
    }

    const tsaAsn1 = children(parseDer(tsaResponse));
    const statusValue = readSmallInteger(children(tsaAsn1[0])[0]);
    if (statusValue !== 0 && statusValue !== 1) {
      throw new Error(`TSA returned non-granted status: ${statusValue}`);
    }
    if (tsaAsn1.length < 2) {
      throw new Error("TSA response missing TimeStampToken");
    }

    const timestampAttr = asn1.sequence([
      asn1.oid("1.2.840.113549.1.9.16.2.14"),
      asn1.set([tsaAsn1[1]]),
    ]);

    const lastItem = signerInfoFields[signerInfoFields.length - 1];
    if (isContext(lastItem, 1)) {
      children(lastItem).push(timestampAttr);
    } else {
      signerInfoFields.push(asn1.context(1, [timestampAttr]));
    }

    return encodeDer(contentInfo);
  }

  /**
   * Request a timestamp token from a TSA (RFC 3161).
   * Tries each configured TSA URL in order (primary -> fallback1 -> fallback2).
   * Required for the PAdES-B-T signature time-stamp attribute used here.
   *
   * Uses the native HTTPS module (NOT fetch) so that global-agent
   * can route the request through the configured HTTP_PROXY.
   */
  async getTimestamp(
    messageImprint: Buffer,
    timestampContext?: TimestampContext,
  ): Promise<Buffer | null> {
    if (this.tsaUrls.length === 0) return null;
    await this.assertQualifiedTsaConfirmed();
    let accepted: { tsaUrl: string; response: Buffer } | null = null;
    const { body: tsReqBody, nonce } =
      this.buildTimestampRequest(messageImprint);

    // Try each TSA URL in sequence until one succeeds
    const errors: string[] = [];

    for (let i = 0; i < this.tsaUrls.length; i++) {
      const tsaUrl = this.tsaUrls[i];
      const label = i === 0 ? "primary" : `fallback-${i}`;

      try {
        const tsResponse = await this.requestTsa(tsaUrl, tsReqBody);
        const evidence = this.validateTimestampResponse(
          tsResponse,
          messageImprint,
          nonce,
        );
        this.logger.log(
          `Validated RFC 3161 token from TSA ${label}: policy=${evidence.policyOid}, ` +
            `serial=${evidence.serialNumber}, genTime=${evidence.generatedAt.toISOString()}, ` +
            `certificate=${evidence.certificateFingerprintSha256}`,
        );
        accepted = { tsaUrl, response: tsResponse };
        break;
      } catch {
        const msg = `TSA ${label} failed`;
        errors.push(msg);
        this.logger.warn(msg);
        // Continue to next fallback
      }
    }

    if (accepted) {
      // Outside the fallback loop: an archive failure is not a TSA failure.
      await this.archiveTimestamp(
        messageImprint,
        tsReqBody,
        accepted,
        timestampContext,
      );
      return accepted.response;
    }

    // All TSAs failed
    this.logger.error(
      `All ${this.tsaUrls.length} TSA(s) failed. Errors:\n  ${errors.join("\n  ")}`,
    );
    return null;
  }

  /**
   * With SIGNING_TSA_REQUIRE_QUALIFIED_STATUS=true, no timestamp is requested
   * unless a recent Trusted List check confirmed the pinned TSA as a granted
   * qualified time stamp service.
   */
  private async assertQualifiedTsaConfirmed() {
    if (
      process.env.SIGNING_TSA_REQUIRE_QUALIFIED_STATUS?.trim().toLowerCase() !==
      "true"
    ) {
      return;
    }
    const maxAgeDays =
      Number.parseInt(process.env.SIGNING_TSA_TRUSTED_LIST_MAX_AGE_DAYS || "", 10) || 7;
    const latest = await this.prisma?.trustedListCheck.findFirst({
      orderBy: { checkedAt: "desc" },
    });
    if (
      !latest ||
      latest.result !== "OK" ||
      Date.now() - latest.checkedAt.getTime() > maxAgeDays * 86_400_000
    ) {
      throw new Error(
        "The qualified status of the TSA is not confirmed by a recent Trusted List check",
      );
    }
  }

  /**
   * Keeps the raw request and response of an accepted timestamp, so the
   * request nonce and the untouched TSA answer stay checkable by an expert.
   * Calls without a seal context (tests, tooling) keep nothing.
   */
  private async archiveTimestamp(
    messageImprint: Buffer,
    request: Buffer,
    accepted: { tsaUrl: string; response: Buffer },
    timestampContext?: TimestampContext,
  ) {
    if (!this.prisma || !timestampContext) return;
    const data = {
      scope: timestampContext.scope,
      documentId: timestampContext.documentId ?? null,
      webauthnCredentialId: timestampContext.webauthnCredentialId ?? null,
      tsaUrl: accepted.tsaUrl,
      requestBase64: request.toString("base64"),
      responseBase64: accepted.response.toString("base64"),
    };
    await this.prisma.signingTimestamp.upsert({
      where: { messageImprint: messageImprint.toString("hex") },
      create: { messageImprint: messageImprint.toString("hex"), ...data },
      update: data,
    });
  }

  /**
   * Build the DER TimeStampReq. Its messageImprint contains the SHA-256 digest
   * supplied by the caller; the source PDF/document is never part of the body.
   */
  private buildTimestampRequest(messageImprint: Buffer): {
    body: Buffer;
    nonce: Buffer;
  } {
    if (messageImprint.length !== 32) {
      throw new Error(
        "RFC 3161 SHA-256 messageImprint must be exactly 32 bytes",
      );
    }

    const nonce = crypto.randomBytes(8);
    // DER INTEGER is signed; keep this random 64-bit nonce positive and
    // non-zero so the exact value can be compared with TSTInfo.nonce.
    nonce[0] &= 0x7f;
    if (nonce.every((byte) => byte === 0)) nonce[nonce.length - 1] = 1;

    const tsReq = asn1.sequence([
      asn1.integer(1),
      asn1.sequence([
        asn1.algorithm("2.16.840.1.101.3.4.2.1"),
        asn1.octetString(messageImprint),
      ]),
      ...(this.tsaPolicyOid ? [asn1.oid(this.tsaPolicyOid)] : []),
      asn1.integer(nonce),
      asn1.boolean(true),
    ]);

    return { body: encodeDer(tsReq), nonce };
  }

  /**
   * Validate the complete TimeStampResp before its TimeStampToken is embedded:
   * status, CMS/TSTInfo types, imprint, nonce, signed attributes, TSA
   * signature, ESSCertID, certificate validity and critical timeStamping EKU.
   * This proves protocol integrity; eIDAS qualification remains a separate
   * trust-list decision about the exact service/certificate.
   */
  private validateTimestampResponse(
    response: Buffer,
    expectedImprint: Buffer,
    expectedNonce: Buffer,
  ): {
    policyOid: string;
    serialNumber: string;
    generatedAt: Date;
    certificateFingerprintSha256: string;
  } {
    const timeStampResp = parseDer(response);
    const respFields = children(timeStampResp);
    if (
      !isUniversal(timeStampResp, Asn1Type.SEQUENCE) ||
      respFields.length !== 2
    ) {
      throw new Error("Invalid RFC 3161 TimeStampResp structure");
    }

    const status = readSmallInteger(children(respFields[0])[0]);
    if (status !== 0 && status !== 1) {
      throw new Error(`TSA returned non-granted status: ${status}`);
    }

    const contentInfo = children(respFields[1]);
    if (readOid(contentInfo[0]) !== "1.2.840.113549.1.7.2") {
      throw new Error("TimeStampToken is not CMS SignedData");
    }

    const signedData = children(children(contentInfo[1])[0]);
    if (signedData.length === 0) {
      throw new Error("TimeStampToken SignedData is missing");
    }

    const encapContentInfo = children(signedData[2]);
    if (readOid(encapContentInfo[0]) !== "1.2.840.113549.1.9.16.1.4") {
      throw new Error("TimeStampToken eContentType is not id-ct-TSTInfo");
    }
    const tstInfoDer = readOctets(children(encapContentInfo[1])[0]);
    if (tstInfoDer.length === 0)
      throw new Error("TimeStampToken TSTInfo is empty");

    const tstInfo = children(parseDer(tstInfoDer));
    if (readSmallInteger(tstInfo[0]) !== 1) {
      throw new Error("Unsupported TSTInfo version");
    }
    const policyOid = readOid(tstInfo[1]);
    if (this.tsaPolicyOid && policyOid !== this.tsaPolicyOid) {
      throw new Error(
        `TSTInfo policy ${policyOid} does not match requested policy ${this.tsaPolicyOid}`,
      );
    }
    const imprint = children(tstInfo[2]);
    const imprintAlgorithm = readOid(children(imprint[0])[0]);
    const returnedImprint = readOctets(imprint[1]);
    if (imprintAlgorithm !== "2.16.840.1.101.3.4.2.1") {
      throw new Error(
        `Unexpected TSTInfo messageImprint algorithm: ${imprintAlgorithm}`,
      );
    }
    if (
      returnedImprint.length !== expectedImprint.length ||
      !crypto.timingSafeEqual(returnedImprint, expectedImprint)
    ) {
      throw new Error("TSTInfo messageImprint does not match the request");
    }

    const serialNumber = this.normalizedIntegerHex(readOctets(tstInfo[3]));
    if (!isUniversal(tstInfo[4], Asn1Type.GENERALIZEDTIME)) {
      throw new Error("Invalid TSTInfo genTime");
    }
    const generatedAt = readTime(tstInfo[4]);

    const nonceNode = tstInfo
      .slice(5)
      .find((node) => isUniversal(node, Asn1Type.INTEGER));
    if (!nonceNode) throw new Error("TSTInfo nonce is missing");
    const returnedNonce = this.normalizedIntegerBytes(readOctets(nonceNode));
    const normalizedExpectedNonce = this.normalizedIntegerBytes(expectedNonce);
    if (
      returnedNonce.length !== normalizedExpectedNonce.length ||
      !crypto.timingSafeEqual(returnedNonce, normalizedExpectedNonce)
    ) {
      throw new Error("TSTInfo nonce does not match the request");
    }

    const signerInfos = signedData[signedData.length - 1];
    if (
      !isUniversal(signerInfos, Asn1Type.SET) ||
      children(signerInfos).length !== 1
    ) {
      throw new Error("TimeStampToken must contain exactly one TSA signature");
    }

    const certificates = signedData.find(
      (node, index) =>
        index > 2 && isContext(node, 0) && Array.isArray(node.value),
    );
    if (!certificates) {
      throw new Error("TSA certificate is missing despite certReq=true");
    }

    const signerInfo = children(children(signerInfos)[0]);
    const signedAttributes = signerInfo[3];
    if (!isContext(signedAttributes, 0)) {
      throw new Error("TSA SignerInfo signed attributes are missing");
    }

    const digestAlgorithmOid = readOid(children(signerInfo[2])[0]);
    const digestName = this.digestNameForOid(digestAlgorithmOid);
    const contentTypeAttribute = this.findCmsAttribute(
      signedAttributes,
      "1.2.840.113549.1.9.3",
    );
    if (
      readOid(children(contentTypeAttribute)[0]) !== "1.2.840.113549.1.9.16.1.4"
    ) {
      throw new Error("TSA signed content-type attribute is invalid");
    }
    const messageDigestAttribute = this.findCmsAttribute(
      signedAttributes,
      "1.2.840.113549.1.9.4",
    );
    const signedMessageDigest = readOctets(children(messageDigestAttribute)[0]);
    const expectedContentDigest = crypto
      .createHash(digestName)
      .update(tstInfoDer)
      .digest();
    if (
      signedMessageDigest.length !== expectedContentDigest.length ||
      !crypto.timingSafeEqual(signedMessageDigest, expectedContentDigest)
    ) {
      throw new Error("TSA signed message-digest attribute is invalid");
    }

    const certificateEntries = children(certificates)
      .filter((node) => isUniversal(node, Asn1Type.SEQUENCE))
      .map((node) => parseCertificate(encodeDer(node)));
    if (certificateEntries.length === 0)
      throw new Error("No X.509 TSA certificate found");

    const sid = signerInfo[1];
    let candidates = certificateEntries;
    if (isUniversal(sid, Asn1Type.SEQUENCE) && children(sid)[1]) {
      // Compare ASN.1 INTEGER values byte-for-byte after removing only
      // sign-padding bytes. Do not strip hexadecimal characters: a valid
      // serial such as 01ab... must not become 1ab....
      const sidSerial = this.normalizedIntegerHex(readOctets(children(sid)[1]));
      candidates = certificateEntries.filter(
        (certificate) =>
          this.normalizedIntegerHex(certificate.serial) === sidSerial,
      );
    }
    if (candidates.length === 0)
      throw new Error("TSA signing certificate not found");

    const signedAttributesDer = encodeDer(asn1.set(children(signedAttributes)));
    const signatureAlgorithmOid = readOid(children(signerInfo[4])[0]);
    const signature = readOctets(signerInfo[5]);

    let verifiedCertificate: ParsedCertificate | null = null;
    for (const candidate of candidates) {
      const publicKey = candidate.x509.publicKey;
      if (this.hasUnsafeRsaPublicExponent(publicKey)) continue;
      const verificationKey =
        signatureAlgorithmOid === "1.2.840.113549.1.1.10"
          ? {
              key: publicKey,
              padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
              saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO,
            }
          : publicKey;
      if (
        crypto.verify(
          digestName,
          signedAttributesDer,
          verificationKey,
          signature,
        )
      ) {
        if (verifiedCertificate) {
          throw new Error("Ambiguous TSA signing certificate");
        }
        verifiedCertificate = candidate;
      }
    }
    if (!verifiedCertificate) {
      throw new Error("TSA CMS signature verification failed");
    }

    const timeStampingEku = "1.3.6.1.5.5.7.3.8";
    const ekuExtensions = verifiedCertificate.extensions.filter(
      (extension) => extension.oid === "2.5.29.37",
    );
    const eku = ekuExtensions[0];
    const ekuPurposes = eku ? children(parseDer(eku.value)).map(readOid) : [];
    if (
      ekuExtensions.length !== 1 ||
      eku.critical !== true ||
      !ekuPurposes.includes(timeStampingEku) ||
      ekuPurposes.some((purpose) => purpose !== timeStampingEku)
    ) {
      throw new Error(
        "TSA certificate lacks the exclusive critical timeStamping EKU",
      );
    }
    if (
      generatedAt < verifiedCertificate.notBefore ||
      generatedAt > verifiedCertificate.notAfter
    ) {
      throw new Error(
        "TSTInfo genTime is outside the TSA certificate validity period",
      );
    }

    this.verifyEssCertificateIdentifier(
      signedAttributes,
      verifiedCertificate.der,
    );
    this.verifyTimestampCertificateTrust(
      verifiedCertificate,
      certificateEntries,
      generatedAt,
    );

    return {
      policyOid,
      serialNumber,
      generatedAt,
      certificateFingerprintSha256: crypto
        .createHash("sha256")
        .update(verifiedCertificate.der)
        .digest("hex"),
    };
  }

  private verifyTimestampCertificateTrust(
    signerCertificate: ParsedCertificate,
    certificates: ParsedCertificate[],
    generatedAt: Date,
  ): void {
    if (this.tsaTrustedCertFingerprints.size === 0) return;

    let current = signerCertificate;
    const visited = new Set<string>();

    for (let depth = 0; depth < 10; depth++) {
      const fingerprint = crypto
        .createHash("sha256")
        .update(current.der)
        .digest("hex");
      if (visited.has(fingerprint)) break;
      visited.add(fingerprint);

      if (generatedAt < current.notBefore || generatedAt > current.notAfter) {
        throw new Error(
          "TSA certificate chain was not valid at TSTInfo genTime",
        );
      }
      if (this.tsaTrustedCertFingerprints.has(fingerprint)) return;

      const issuer = certificates.find((candidate) => {
        if (
          candidate === current ||
          !candidate.subjectDer.equals(current.issuerDer)
        ) {
          return false;
        }
        return this.verifyCertificateSignatureWithOpenSsl(current, candidate);
      });
      if (!issuer) break;
      current = issuer;
    }

    throw new Error(
      "TSA certificate chain does not reach a configured SHA-256 trust fingerprint",
    );
  }

  /**
   * Certificate signatures are checked by OpenSSL, whose PKCS#1 v1.5 verifier
   * rejects malformed DigestInfo values (the CVE-2026-85393 forgery shape).
   * RSA keys whose public exponent is 3 are refused as a second, explicit
   * policy boundary against low-exponent forgeries.
   */
  private verifyCertificateSignatureWithOpenSsl(
    certificate: ParsedCertificate,
    issuer: ParsedCertificate,
  ): boolean {
    try {
      if (this.hasUnsafeRsaPublicExponent(issuer.x509.publicKey)) return false;
      return certificate.x509.verify(issuer.x509.publicKey);
    } catch {
      return false;
    }
  }

  private hasUnsafeRsaPublicExponent(publicKey: crypto.KeyObject): boolean {
    return (
      (publicKey.asymmetricKeyType === "rsa" ||
        publicKey.asymmetricKeyType === "rsa-pss") &&
      publicKey.asymmetricKeyDetails?.publicExponent === 3n
    );
  }

  private findCmsAttribute(signedAttributes: Asn1Node, oid: string): Asn1Node {
    const attribute = children(signedAttributes).find(
      (candidate) => readOid(children(candidate)[0]) === oid,
    );
    const values = children(attribute)[1];
    if (!values) throw new Error(`Required CMS attribute missing: ${oid}`);
    return values;
  }

  private verifyEssCertificateIdentifier(
    signedAttributes: Asn1Node,
    certificateDer: Buffer,
  ): void {
    const attribute = (oid: string) =>
      children(signedAttributes).find(
        (candidate) => readOid(children(candidate)[0]) === oid,
      );
    const v1 = attribute("1.2.840.113549.1.9.16.2.12");
    const v2 = attribute("1.2.840.113549.1.9.16.2.47");
    if (!v1 && !v2)
      throw new Error("TSA SigningCertificate/ESSCertID attribute is missing");

    // Attribute -> SET -> SigningCertificate(V2) -> certs -> first ESSCertID.
    const firstEssCertId = (signingCertificate: Asn1Node) =>
      children(children(children(children(signingCertificate)[1])[0])[0])[0];

    let hashName = "sha1";
    let hashNode: Asn1Node | undefined;
    if (v2) {
      const essCertId = children(firstEssCertId(v2));
      if (essCertId.length === 0)
        throw new Error("Malformed TSA SigningCertificateV2 attribute");
      if (essCertId[0]?.type === Asn1Type.SEQUENCE) {
        hashName = this.digestNameForOid(readOid(children(essCertId[0])[0]));
        hashNode = essCertId[1];
      } else {
        hashName = "sha256";
        hashNode = essCertId[0];
      }
    } else {
      const essCertId = children(firstEssCertId(v1));
      if (essCertId.length === 0)
        throw new Error("Malformed TSA SigningCertificate attribute");
      hashNode = essCertId[0];
    }

    const returnedHash = readOctets(hashNode);
    const expectedHash = crypto
      .createHash(hashName)
      .update(certificateDer)
      .digest();
    if (
      returnedHash.length !== expectedHash.length ||
      !crypto.timingSafeEqual(returnedHash, expectedHash)
    ) {
      throw new Error(
        "TSA ESSCertID does not identify the CMS signing certificate",
      );
    }
  }

  private digestNameForOid(oid: string): string {
    const digestNames: Record<string, string> = {
      "1.3.14.3.2.26": "sha1",
      "2.16.840.1.101.3.4.2.1": "sha256",
      "2.16.840.1.101.3.4.2.2": "sha384",
      "2.16.840.1.101.3.4.2.3": "sha512",
    };
    const digestName = digestNames[oid];
    if (!digestName)
      throw new Error(`Unsupported TSA digest algorithm: ${oid}`);
    return digestName;
  }

  private normalizedIntegerBytes(value: Buffer): Buffer {
    let offset = 0;
    while (offset < value.length - 1 && value[offset] === 0) offset++;
    return value.subarray(offset);
  }

  private normalizedIntegerHex(value: Buffer): string {
    return this.normalizedIntegerBytes(value).toString("hex").toLowerCase();
  }

  /**
   * Send a single TimeStampReq to a specific TSA URL.
   * Uses the native HTTPS module (patched by global-agent for proxy support).
   * Timeout: 10 seconds per request.
   */
  private requestTsa(tsaUrl: string, tsReqBody: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const url = new URL(tsaUrl);
      if (url.protocol !== "https:") {
        reject(
          new Error(
            `TSA URL must use HTTPS (got ${url.protocol}). Refusing cleartext timestamp request.`,
          ),
        );
        return;
      }

      const req = https.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/timestamp-query",
            Accept: "application/timestamp-reply",
            "Content-Length": tsReqBody.length,
          },
          timeout: 10_000, // 10s per TSA attempt
        },
        (res: any) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const contentType = String(res.headers["content-type"] || "")
            .split(";", 1)[0]
            .trim()
            .toLowerCase();
          if (
            contentType !== "application/timestamp-reply" &&
            contentType !== "application/timestamp-response"
          ) {
            res.resume();
            reject(
              new Error(
                `Unexpected TSA Content-Type: ${contentType || "missing"}`,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let responseSize = 0;
          res.on("data", (chunk: Buffer) => {
            responseSize += chunk.length;
            if (responseSize > 1024 * 1024) {
              req.destroy(new Error("TSA response exceeds 1 MiB"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout (10s)"));
      });
      req.on("error", reject);
      req.write(tsReqBody);
      req.end();
    });
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
    } catch {
      this.logger.error("Failed to load certificate");
      return null;
    }
  }

  /**
   * Generate a signing certificate verification page (PDF page).
   * This page is appended as the last page of the signed document.
   * Contains: signature details, timestamp, hash, QR code, audit info.
   */
  async generateCertificatePage(documentInfo: {
    documentId: string;
    fileName: string;
    signedAt: Date;
    signers: Array<{
      name: string;
      email: string;
      signedAt: Date;
      signatureType: string;
      authenticationMethod?: string | null;
      identityVerificationMethod?: string | null;
      accountAssigned?: boolean;
      transactionBound?: boolean;
      signingIntentHash?: string | null;
      signedDocumentHash?: string | null;
      webauthnUserVerified?: boolean | null;
      evidenceId?: string | null;
      forensicRecordSha256?: string | null;
    }>;
    documentHash: string;
    signatureLevel: string;
  }): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage([595.28, 841.89]); // A4

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const isReinforced = documentInfo.signatureLevel === "REINFORCED";
    const authenticationLabel = (method?: string | null) => {
      if (method === "EMAIL_OTP_CONSENT") {
        return "Code e-mail à usage unique + consentement";
      }
      if (method === "WEBAUTHN") {
        return "Passkey WebAuthn liée à la transaction";
      }
      return "Méthode non enregistrée";
    };
    // How the account or address behind the signer was checked. This is
    // account-level assurance, never a civil identity check.
    const verificationLabel = (method?: string | null) => {
      if (method === "EMAIL_OTP") {
        return "Contrôle de l'adresse e-mail par code à usage unique";
      }
      if (method === "VERIFIED_EMAIL_ACCOUNT") {
        return "Adresse e-mail vérifiée par lien de confirmation";
      }
      if (method === "ADMIN_VERIFIED_EMAIL_ACCOUNT") {
        return "Adresse e-mail vérifiée par un administrateur";
      }
      if (method === "LDAP_ACCOUNT") return "Identité fournie par l'annuaire LDAP";
      if (method === "OIDC_ACCOUNT") return "Identité fournie par le fournisseur OIDC";
      return "Aucune vérification enregistrée";
    };

    const { width: _width, height } = page.getSize();
    let y = height - 60;
    // The dossier grows with the number of signers, so it continues on as
    // many A4 pages as needed instead of running off the bottom edge.
    const ensureSpace = (needed: number) => {
      if (y - needed >= 50) return;
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 60;
    };
    const wrapped = (line: string) =>
      this.wrapPdfText(pdfSafeText(line, font), 470, 9);

    // Header
    page.drawText("DOSSIER DE PREUVE DE SIGNATURE ÉLECTRONIQUE", {
      x: 50,
      y,
      size: 16,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.4),
    });
    y -= 30;

    page.drawText(
      isReinforced
        ? "Niveau renforcé - compte attribué et confirmation WebAuthn"
        : "Niveau standard - contrôle de l'adresse e-mail et consentement",
      {
        x: 50,
        y,
        size: 10,
        font,
        color: rgb(0.3, 0.3, 0.3),
      },
    );
    y -= 40;

    // Document info
    ensureSpace(40);
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
      `Niveau de preuve: ${isReinforced ? "Renforcé - compte vérifié + passkey" : "Standard - code e-mail + consentement"}`,
      // Each hash names its exact scope: a file cannot contain its own hash,
      // so the final PDF hash lives in the attestation, not here.
      `Empreinte du contenu signé (avant page de preuve et scellement): ${documentInfo.documentHash}`,
      "Empreinte du fichier PDF final: figure dans l'attestation de preuve, un fichier ne pouvant contenir sa propre empreinte",
      `Date de finalisation: ${documentInfo.signedAt.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "medium", timeZone: "Europe/Paris" })}`,
    ];

    for (const line of lines.flatMap(wrapped)) {
      ensureSpace(15);
      page.drawText(line, { x: 70, y, size: 9, font });
      y -= 15;
    }
    y -= 20;

    // Signers
    ensureSpace(40);
    page.drawText("SIGNATAIRES", {
      x: 50,
      y,
      size: 12,
      font: fontBold,
    });
    y -= 20;

    for (let i = 0; i < documentInfo.signers.length; i++) {
      const signer = documentInfo.signers[i];
      ensureSpace(30);
      page.drawText(`Signataire ${i + 1}:`, {
        x: 70,
        y,
        size: 10,
        font: fontBold,
      });
      y -= 15;

      // Network data and account identifiers stay in the forensic dossier.
      // Its salted hash below lets anyone check a record disclosed later.
      const signerLines = [
        `  Nom: ${signer.name}`,
        `  Email: ${signer.email}`,
        ...(signer.evidenceId
          ? [`  Identifiant de preuve: ${signer.evidenceId}`]
          : []),
        "  Adresse IP: enregistrée dans le dossier probatoire",
        `  Signé le: ${signer.signedAt.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "medium", timeZone: "Europe/Paris" })}`,
        `  Type de signature: ${signer.signatureType}`,
        `  Authentification: ${authenticationLabel(signer.authenticationMethod)}`,
        signer.accountAssigned
          ? "  Attribution du signataire: compte PrivCloud attribué"
          : "  Attribution du signataire: destinataire désigné par son adresse e-mail",
        `  ${signer.accountAssigned ? "Vérification du compte" : "Vérification de l'adresse"}: ${verificationLabel(signer.identityVerificationMethod)}`,
        ...(signer.webauthnUserVerified
          ? ["  Vérification locale WebAuthn: oui"]
          : []),
        ...(signer.transactionBound
          ? ["  Transaction liée au document: vérifiée"]
          : []),
        ...(signer.signedDocumentHash
          ? [
              `  Empreinte du document source approuvé: ${signer.signedDocumentHash}`,
            ]
          : []),
        `  Empreinte du texte de consentement: ${consentSha256For("SIGN")}`,
        ...(signer.signingIntentHash
          ? [
              `  Empreinte du manifeste de transaction: ${signer.signingIntentHash}`,
            ]
          : []),
        ...(signer.forensicRecordSha256
          ? [
              `  Empreinte du dossier probatoire: ${signer.forensicRecordSha256}`,
            ]
          : []),
      ];

      for (const line of signerLines.flatMap(wrapped)) {
        ensureSpace(14);
        page.drawText(line, { x: 80, y, size: 9, font });
        y -= 14;
      }
      y -= 10;
    }
    y -= 20;

    // Legal notice
    ensureSpace(40);
    page.drawText("MENTION LÉGALE", {
      x: 50,
      y,
      size: 12,
      font: fontBold,
    });
    y -= 20;

    const levelSpecificLegalText = isReinforced
      ? [
          "Le profil renforcé de PrivCloud met en œuvre une signature électronique avancée conformément aux",
          "exigences de l'article 26 du règlement eIDAS. Elle repose sur une assertion WebAuthn transactionnelle",
          "et s'accompagne d'un scellement cryptographique CMS/PDF du dossier de preuve apposé par PrivCloud.",
          "Chaque décision fait l'objet d'une assertion WebAuthn dont le challenge est dérivé d'un manifeste",
          "liant le compte attribué, le consentement et l'empreinte exacte du document. La clé WebAuthn est",
          "rattachée au compte par une preuve d'enrôlement signée. L'assertion brute, la clé publique et les",
          "données réseau sont conservées dans un dossier probatoire scellé, communiqué en cas de contestation",
          "et vérifiable hors ligne grâce aux empreintes ci-dessus. Il ne s'agit ni d'une identité civile",
          "qualifiée, ni d'une signature électronique qualifiée (QES).",
        ]
      : [
          "Le niveau standard exige un code à usage unique envoyé à l'adresse e-mail attribuée avant",
          "la décision. Cette preuve établit le contrôle actuel de la boîte, pas l'identité civile de la",
          "personne qui saisit le code ni une maîtrise personnelle exclusive et durable de cette adresse.",
          "Le consentement est lié à l'empreinte du document. PrivCloud ne présente pas ce parcours comme",
          "une signature avancée conforme à l'article 26, ni comme une signature électronique qualifiée.",
        ];
    const legalText = [
      "Le règlement eIDAS interdit de refuser l'effet juridique ou l'admissibilité d'une signature",
      "au seul motif de sa forme électronique ou de son caractère non qualifié (article 25, paragraphe 1).",
      "",
      ...levelSpecificLegalText,
      "",
      "Le fichier final comporte une signature CMS/PDF du serveur destinée à détecter toute modification.",
      "Cette signature technique du serveur n'est pas la signature personnelle du signataire.",
      "La piste d'audit est chaînée par SHA-256 à compter de l'activation de cette fonctionnalité.",
      "Les adresses IP et identifiants techniques, conservés pour établir la preuve et prévenir la fraude,",
      "ne sont pas diffusés aux parties. Chaque signataire peut obtenir les données qui le concernent.",
      "Lorsque l'horodatage est activé, seule l'empreinte SHA-256 de la valeur de signature est",
      "soumise à la TSA. La réponse RFC 3161 (empreinte, nonce, heure, signature et certificat TSA)",
      "est vérifiée avant que son jeton cryptographique soit incorporé au CMS/PDF, le document n'est",
      "alors finalisé que si ce jeton est valide, sauf dérogation serveur explicitement configurée.",
      "",
      "Le caractère qualifié de l'horodatage dépend du service TSA et du certificat effectivement employés,",
      "tels qu'inscrits dans la Trusted List applicable. Il ne résulte pas du seul protocole RFC 3161.",
    ];

    for (const line of legalText) {
      ensureSpace(12);
      page.drawText(line, { x: 70, y, size: 8, font });
      y -= 12;
    }

    // Footer on every page of the dossier
    const generatedAt = new Date().toLocaleString("fr-FR", {
      dateStyle: "long",
      timeStyle: "medium",
      timeZone: "Europe/Paris",
    });
    const pages = pdfDoc.getPages();
    pages.forEach((dossierPage, index) =>
      dossierPage.drawText(
        pages.length > 1
          ? `Généré par PrivCloud Sharing - ${generatedAt} - page ${index + 1}/${pages.length}`
          : `Généré par PrivCloud Sharing - ${generatedAt}`,
        { x: 50, y: 30, size: 7, font, color: rgb(0.5, 0.5, 0.5) },
      ),
    );

    return Buffer.from(await pdfDoc.save());
  }

  /**
   * Add "Bon pour Accord" diagonal watermark and signature fields to a PDF.
   * Watermark and signature can be placed on different pages.
   * If a requested page exceeds existing page count, blank pages are appended.
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
      signaturePage?: number; // 1-based page number for signature (default: 1)
      watermarkPage?: number; // 1-based page number for watermark (default: same as signaturePage)
      signatureField?: {
        page: number;
        posX: number;
        posY: number;
        width: number;
        height: number;
      };
      /** Position in the default grid when the signer has no field. */
      defaultSlot?: { index: number; count: number };
    } = { addApprovalWatermark: true },
  ): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts, degrees } =
      await import("pdf-lib");

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    let pages = pdfDoc.getPages();

    // Resolve target pages (1-based -> 0-based index)
    const sigPageIdx =
      (options.signatureField?.page ?? options.signaturePage ?? 1) - 1;
    const wmPageIdx = options.addApprovalWatermark
      ? (options.watermarkPage ?? options.signaturePage ?? 1) - 1
      : sigPageIdx;
    const maxPageIdx = options.addApprovalWatermark
      ? Math.max(sigPageIdx, wmPageIdx)
      : sigPageIdx;

    // Add blank pages if needed
    while (pages.length <= maxPageIdx) {
      pdfDoc.addPage();
      pages = pdfDoc.getPages();
    }

    const signaturePage = pages[sigPageIdx];
    const watermarkPage = options.addApprovalWatermark
      ? pages[wmPageIdx]
      : undefined;

    const { width: sigRawWidth, height: sigRawHeight } = signaturePage.getSize();
    const sigGeometry = {
      width: sigRawWidth,
      height: sigRawHeight,
      rotation: signaturePage.getRotation().angle,
    };
    const { width: sigWidth, height: sigHeight } = visualPageSize(sigGeometry);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Add diagonal "Bon pour Accord" watermark on the WATERMARK page
    if (options.addApprovalWatermark && watermarkPage) {
      const { width: wmWidth, height: wmHeight } = watermarkPage.getSize();
      const wmGeometry = {
        width: wmWidth,
        height: wmHeight,
        rotation: watermarkPage.getRotation().angle,
      };
      const wmVisualSize = visualPageSize(wmGeometry);
      const watermarkOrigin = visualPdfPointToRaw(
        { x: wmVisualSize.width * 0.12, y: wmVisualSize.height * 0.38 },
        wmGeometry,
      );
      watermarkPage.drawText("Bon pour Accord", {
        x: watermarkOrigin.x,
        y: watermarkOrigin.y,
        size: 60,
        font: fontBold,
        color: rgb(0.5, 0.75, 0.5),
        opacity: 0.35,
        rotate: degrees(normalizedPdfRotation(wmGeometry.rotation) + 45),
      });
    }

    // Add "Lu et approuvé" mention + signature on the SIGNATURE page
    const addMention = options.addApprovalMention !== false;
    const dateStr = signerInfo.signedDate.toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Paris",
    });

    const approvalText = `Lu et approuvé le ${dateStr}`;
    const nameText = pdfSafeText(signerInfo.name, fontBold);
    const signatureText = signerInfo.signatureText
      ? pdfSafeText(signerInfo.signatureText, font)
      : undefined;

    const visualField = options.signatureField
      ? rawPdfBoxToVisual(
          {
            x: options.signatureField.posX,
            y: options.signatureField.posY,
            width: options.signatureField.width,
            height: options.signatureField.height,
          },
          sigGeometry,
        )
      : undefined;
    const signatureBoxWidth = Math.min(
      Math.max(visualField?.width || 240, 120),
      sigWidth,
    );
    const signatureBoxHeight = Math.min(
      Math.max(visualField?.height || (addMention ? 90 : 70), 50),
      sigHeight,
    );
    const defaultPosition = defaultSignatureSlotPosition({
      index: options.defaultSlot?.index ?? 0,
      count: options.defaultSlot?.count ?? 1,
      pageWidth: sigWidth,
      boxWidth: signatureBoxWidth,
      boxHeight: signatureBoxHeight,
      rightEdge: sigWidth - 20,
      baseY: 110,
    });
    const sigX = visualField
      ? Math.min(Math.max(visualField.x, 0), sigWidth - signatureBoxWidth)
      : defaultPosition.x;
    const sigY = visualField
      ? Math.min(Math.max(visualField.y, 0), sigHeight - signatureBoxHeight)
      : defaultPosition.y;
    const paddingX = 8;
    const paddingY = 8;
    let signatureImage: any = null;
    let signatureImageWidth = 0;
    let signatureImageHeight = 0;
    const signatureMaxWidth = Math.max(20, signatureBoxWidth - paddingX * 2);

    if (signerInfo.signatureImage) {
      signatureImage = await this.embedSignatureImage(
        pdfDoc,
        signerInfo.signatureImage,
      );
      const fitted = fitSignatureImage(signatureImage.scale(0.5), {
        width: Math.min(signatureMaxWidth, 180),
        height: Math.min(
          Math.max(28, signatureBoxHeight - (addMention ? 42 : 26)),
          40,
        ),
      });
      signatureImageWidth = fitted.width;
      signatureImageHeight = fitted.height;
    }

    const signatureTextWidth = signatureText
      ? Math.min(
          font.widthOfTextAtSize(signatureText, 14),
          signatureMaxWidth,
        )
      : 0;
    const approvalWidth = addMention
      ? Math.min(font.widthOfTextAtSize(approvalText, 9), signatureMaxWidth)
      : 0;
    const nameWidth = Math.min(
      fontBold.widthOfTextAtSize(nameText, 10),
      signatureMaxWidth,
    );
    const visualSignatureHeight = signatureImage
      ? signatureImageHeight
      : signatureText
        ? 18
        : 24;

    const contentWidth = Math.min(
      signatureBoxWidth,
      Math.max(
        80,
        approvalWidth,
        nameWidth,
        signatureImageWidth,
        signatureTextWidth,
      ) +
        paddingX * 2,
    );
    const contentHeight = Math.min(
      signatureBoxHeight,
      Math.max(
        44,
        paddingY * 2 + (addMention ? 13 : 0) + 14 + 6 + visualSignatureHeight,
      ),
    );
    const contentPosition = this.placeContentWithinBox({
      boxX: sigX,
      boxY: sigY,
      boxWidth: signatureBoxWidth,
      boxHeight: signatureBoxHeight,
      contentWidth,
      contentHeight,
      pageWidth: sigWidth,
      pageHeight: sigHeight,
    });
    const innerX = contentPosition.x + paddingX;
    const imageY = contentPosition.y + paddingY;
    const drawRotation = normalizedPdfRotation(sigGeometry.rotation);
    const contentOrigin = visualPdfPointToRaw(contentPosition, sigGeometry);

    signaturePage.drawRectangle({
      x: contentOrigin.x,
      y: contentOrigin.y,
      width: contentWidth,
      height: contentHeight,
      rotate: degrees(drawRotation),
      color: rgb(1, 1, 1),
      opacity: 1,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 0.8,
    });

    if (addMention) {
      // "Lu et approuvé le ..."
      const approvalOrigin = visualPdfPointToRaw(
        {
          x: innerX,
          y: contentPosition.y + contentHeight - paddingY - 9,
        },
        sigGeometry,
      );
      signaturePage.drawText(approvalText, {
        x: approvalOrigin.x,
        y: approvalOrigin.y,
        size: 9,
        font,
        color: rgb(0.15, 0.15, 0.15),
        rotate: degrees(drawRotation),
      });
    }

    // Signer name above signature
    const nameOrigin = visualPdfPointToRaw(
      {
        x: innerX,
        y:
          contentPosition.y +
          contentHeight -
          paddingY -
          (addMention ? 26 : 12),
      },
      sigGeometry,
    );
    signaturePage.drawText(nameText, {
      x: nameOrigin.x,
      y: nameOrigin.y,
      size: 10,
      font: fontBold,
      color: rgb(0, 0, 0),
      rotate: degrees(drawRotation),
    });

    if (signatureImage) {
      const imageOrigin = visualPdfPointToRaw(
        { x: innerX, y: imageY },
        sigGeometry,
      );
      signaturePage.drawImage(signatureImage, {
        x: imageOrigin.x,
        y: imageOrigin.y,
        width: signatureImageWidth,
        height: signatureImageHeight,
        rotate: degrees(drawRotation),
      });
    } else if (signatureText) {
      // Text-based signature (italic style)
      const signatureOrigin = visualPdfPointToRaw(
        { x: innerX, y: imageY + 10 },
        sigGeometry,
      );
      signaturePage.drawText(signatureText, {
        x: signatureOrigin.x,
        y: signatureOrigin.y,
        size: 14,
        font,
        color: rgb(0.1, 0.1, 0.5),
        rotate: degrees(drawRotation),
      });
    }

    return Buffer.from(await pdfDoc.save());
  }

  async addSignatureFieldValues(
    pdfBuffer: Buffer,
    fields: Array<{
      id: string;
      type: string;
      page: number;
      posX: number;
      posY: number;
      width: number;
      height: number;
      label?: string | null;
      fieldValues: Array<{
        value: string;
        recipient: {
          name: string;
          email: string;
        };
      }>;
    }>,
  ): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts, degrees } =
      await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let pages = pdfDoc.getPages();
    const maxPage = Math.max(1, ...fields.map((field) => field.page || 1));
    while (pages.length < maxPage) {
      pdfDoc.addPage();
      pages = pdfDoc.getPages();
    }

    for (const field of fields) {
      if (field.type === "SIGNATURE" || field.type === "INITIALS") continue;
      for (const fieldValue of field.fieldValues) {
        const page = pages[Math.max(0, field.page - 1)];
        const { width: rawWidth, height: rawHeight } = page.getSize();
        const pageGeometry = {
          width: rawWidth,
          height: rawHeight,
          rotation: page.getRotation().angle,
        };
        const { width: pageWidth, height: pageHeight } =
          visualPageSize(pageGeometry);
        const visualField = rawPdfBoxToVisual(
          {
            x: field.posX,
            y: field.posY,
            width: field.width,
            height: field.height,
          },
          pageGeometry,
        );
        const boxWidth = Math.min(
          Math.max(visualField.width || 200, 80),
          pageWidth,
        );
        const boxHeight = Math.min(
          Math.max(visualField.height || 42, 24),
          pageHeight,
        );
        const title =
          field.type === "APPROVAL"
            ? "Mention manuscrite"
            : field.type === "DATE"
              ? "Date"
              : pdfSafeText(field.label || "Texte", fontBold);
        const x = Math.min(
          Math.max(visualField.x || 0, 0),
          pageWidth - boxWidth,
        );
        const y = Math.min(
          Math.max(visualField.y || 0, 0),
          pageHeight - boxHeight,
        );
        const paddingX = 6;
        const paddingY = 6;
        const titleSize = 7;
        const valueSize = field.type === "APPROVAL" ? 9 : 8;
        const lineHeight = valueSize + 3;
        const value = pdfSafeText(fieldValue.value.trim(), font);
        const lines = this.wrapPdfText(
          value,
          Math.max(20, boxWidth - paddingX * 2),
          valueSize,
        );
        const visibleLines = lines.slice(
          0,
          Math.max(1, Math.floor((boxHeight - paddingY * 2 - 14) / lineHeight)),
        );
        const textWidth = Math.max(
          fontBold.widthOfTextAtSize(title, titleSize),
          ...visibleLines.map((line) =>
            font.widthOfTextAtSize(line, valueSize),
          ),
          40,
        );
        const contentWidth = Math.min(boxWidth, textWidth + paddingX * 2);
        const contentHeight = Math.min(
          boxHeight,
          Math.max(
            24,
            paddingY * 2 + 10 + 4 + visibleLines.length * lineHeight,
          ),
        );
        const contentPosition = this.placeContentWithinBox({
          boxX: x,
          boxY: y,
          boxWidth,
          boxHeight,
          contentWidth,
          contentHeight,
          pageWidth,
          pageHeight,
        });
        const drawRotation = normalizedPdfRotation(pageGeometry.rotation);
        const contentOrigin = visualPdfPointToRaw(
          contentPosition,
          pageGeometry,
        );

        page.drawRectangle({
          x: contentOrigin.x,
          y: contentOrigin.y,
          width: contentWidth,
          height: contentHeight,
          rotate: degrees(drawRotation),
          color: rgb(1, 1, 1),
          opacity: 0.94,
          borderColor: rgb(0.55, 0.55, 0.55),
          borderWidth: 0.6,
        });

        const titleOrigin = visualPdfPointToRaw(
          {
            x: contentPosition.x + paddingX,
            y: contentPosition.y + contentHeight - paddingY - 7,
          },
          pageGeometry,
        );
        page.drawText(title, {
          x: titleOrigin.x,
          y: titleOrigin.y,
          size: titleSize,
          font: fontBold,
          color: rgb(0.32, 0.32, 0.32),
          rotate: degrees(drawRotation),
        });

        let textY = contentPosition.y + contentHeight - paddingY - 21;
        for (const line of visibleLines) {
          const lineOrigin = visualPdfPointToRaw(
            { x: contentPosition.x + paddingX, y: textY },
            pageGeometry,
          );
          page.drawText(line, {
            x: lineOrigin.x,
            y: lineOrigin.y,
            size: valueSize,
            font,
            color: rgb(0.05, 0.05, 0.05),
            rotate: degrees(drawRotation),
          });
          textY -= lineHeight;
        }
      }
    }

    return Buffer.from(await pdfDoc.save());
  }

  private placeContentWithinBox(args: {
    boxX: number;
    boxY: number;
    boxWidth: number;
    boxHeight: number;
    contentWidth: number;
    contentHeight: number;
    pageWidth: number;
    pageHeight: number;
  }): { x: number; y: number } {
    const horizontalCenter = args.boxX + args.boxWidth / 2;
    const verticalCenter = args.boxY + args.boxHeight / 2;
    const rawX =
      horizontalCenter > args.pageWidth * 0.62
        ? args.boxX + args.boxWidth - args.contentWidth
        : horizontalCenter < args.pageWidth * 0.38
          ? args.boxX
          : args.boxX + (args.boxWidth - args.contentWidth) / 2;
    const rawY =
      verticalCenter > args.pageHeight * 0.62
        ? args.boxY + args.boxHeight - args.contentHeight
        : verticalCenter < args.pageHeight * 0.38
          ? args.boxY
          : args.boxY + (args.boxHeight - args.contentHeight) / 2;

    return {
      x: Math.min(Math.max(rawX, 0), args.pageWidth - args.contentWidth),
      y: Math.min(Math.max(rawY, 0), args.pageHeight - args.contentHeight),
    };
  }

  private embedSignatureImage(pdfDoc: PDFDocument, bytes: Uint8Array) {
    return bytes[0] === 0xff && bytes[1] === 0xd8
      ? pdfDoc.embedJpg(bytes)
      : pdfDoc.embedPng(bytes);
  }

  /**
   * Rejects, at signing time, signature data the final PDF could not draw:
   * an unsupported or corrupted image would otherwise make the finalization
   * fail for every signer of the request.
   */
  async assertRenderableSignature(
    signatureData: string,
    signatureType: string,
  ): Promise<void> {
    let visual: SignatureVisual;
    try {
      visual = parseSignatureData(signatureData, signatureType);
    } catch {
      throw new BadRequestException("Invalid signature");
    }
    if (visual.kind === "text") return;
    const { PDFDocument } = await import("pdf-lib");
    try {
      await this.embedSignatureImage(await PDFDocument.create(), visual.bytes);
    } catch {
      throw new BadRequestException("The signature image could not be read");
    }
  }

  private wrapPdfText(
    text: string,
    maxWidth: number,
    fontSize: number,
  ): string[] {
    const averageCharWidth = fontSize * 0.52;
    const maxChars = Math.max(8, Math.floor(maxWidth / averageCharWidth));
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (word.length <= maxChars) {
        current = word;
      } else {
        for (let index = 0; index < word.length; index += maxChars) {
          lines.push(word.slice(index, index + maxChars));
        }
        current = "";
      }
    }

    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }

  /**
   * Add signers' initials at the bottom of every page.
   */
  async addInitialsToAllPages(
    pdfBuffer: Buffer,
    signerNames: string[],
    options: {
      placement?: string | null;
      signaturePage?: number | null;
      includeSignaturePage?: boolean;
    } = {},
  ): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts, degrees } =
      await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const initialsText = pdfSafeText(
      signerNames
        .map((name) =>
          name
            .split(" ")
            .map((w) => [...w][0]?.toUpperCase() || "")
            .join(""),
        )
        .join(" / "),
      font,
    );

    for (const [pageIndex, page] of pages.entries()) {
      if (
        !shouldAddInitialsToPage({
          pageIndex,
          signaturePage: options.signaturePage,
          includeSignaturePage: options.includeSignaturePage,
        })
      ) {
        continue;
      }
      const { width: rawWidth, height: rawHeight } = page.getSize();
      const pageGeometry = {
        width: rawWidth,
        height: rawHeight,
        rotation: page.getRotation().angle,
      };
      const { width, height } = visualPageSize(pageGeometry);
      const fontSize = 9;
      const geometry = getInitialsStampGeometry({
        pageWidth: width,
        pageHeight: height,
        textWidth: font.widthOfTextAtSize(initialsText, fontSize),
        fontSize,
        placement: options.placement,
      });
      const drawRotation = normalizedPdfRotation(pageGeometry.rotation);
      const stampOrigin = visualPdfPointToRaw(geometry, pageGeometry);
      page.drawRectangle({
        x: stampOrigin.x,
        y: stampOrigin.y,
        width: geometry.width,
        height: geometry.height,
        rotate: degrees(drawRotation),
        color: rgb(1, 1, 1),
        opacity: 0.94,
        borderColor: rgb(0.35, 0.35, 0.35),
        borderWidth: 0.6,
        borderOpacity: 0.75,
      });
      const textOrigin = visualPdfPointToRaw(
        {
          x: geometry.x + geometry.textXOffset,
          y: geometry.y + geometry.textYOffset,
        },
        pageGeometry,
      );
      page.drawText(initialsText, {
        x: textOrigin.x,
        y: textOrigin.y,
        size: geometry.fontSize,
        font,
        color: rgb(0.12, 0.12, 0.12),
        rotate: degrees(drawRotation),
      });
    }

    return Buffer.from(await pdfDoc.save());
  }
}
