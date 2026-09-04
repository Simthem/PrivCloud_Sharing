import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import {
  getInitialsStampGeometry,
  shouldAddInitialsToPage,
} from "./initials-placement.util";

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
@Injectable()
export class PdfSigningService {
  private readonly logger = new Logger(PdfSigningService.name);

  private certificatePath: string;
  private certificatePassword: string;
  private tsaUrls: string[];
  private readonly tsaRequired: boolean;
  private readonly tsaPolicyOid?: string;
  private readonly tsaTrustedCertFingerprints: Set<string>;

  constructor() {
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
   * Sign a PDF buffer with a PAdES-B-B signature and upgrade it to PAdES-B-T
   * when an RFC 3161 signature time-stamp token is configured and validated.
   * Uses @signpdf/placeholder-pdf-lib for the /Sig placeholder, then builds
   * a full CMS/PKCS#7 SignedData manually (node-forge) with:
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
          signedPdf = await this.embedTimestampInSignedPdf(signedPdf);
          this.logger.log(
            `PDF signed with timestamp (PAdES-B-T) for ${signerInfo.email} - ` +
              `${signedPdf.length} bytes, reason: "${reason}"`,
          );
        } catch (tsaError: any) {
          if (this.tsaRequired) throw tsaError;
          this.logger.warn(
            `TSA timestamp embedding failed: ${tsaError?.message}. ` +
              "SIGNING_TSA_REQUIRED=false: PDF remains PAdES-B-B without timestamp.",
          );
        }
      } else {
        this.logger.log(
          `PDF signed (PAdES-B-B, no TSA configured) for ${signerInfo.email} - ` +
            `${signedPdf.length} bytes, reason: "${reason}"`,
        );
      }

      return signedPdf;
    } catch (error: any) {
      // SECURITY: Fail-closed - do NOT return an unsigned PDF that would be
      // marked as COMPLETED by the caller. Let the caller handle the failure.
      const msg = `PAdES signing failed: ${error?.message || "Unknown error"}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  /**
   * Create a detached PAdES CMS signature for a SHA-256 PDF ByteRange digest.
   * The PDF stays client-side: only its 32-byte digest reaches this service.
   */
  async signDigest(messageDigest: Buffer): Promise<Buffer> {
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
          cmsDer = await this.embedTimestampInCms(cmsDer);
          this.logger.log(
            `Detached PAdES-B-T CMS created (${cmsDer.length} bytes)`,
          );
        } catch (tsaError: any) {
          if (this.tsaRequired) throw tsaError;
          this.logger.warn(
            `TSA timestamp embedding failed: ${tsaError?.message}. ` +
              "SIGNING_TSA_REQUIRED=false: CMS remains PAdES-B-B without timestamp.",
          );
        }
      }

      return cmsDer;
    } catch (error: any) {
      const msg = `Detached PAdES signing failed: ${error?.message || "Unknown error"}`;
      this.logger.error(msg);
      throw new Error(msg);
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
    const forge = require("node-forge");
    const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString("binary"));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, this.certificatePassword);

    const keyBags = p12.getBags({
      bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
    });
    let privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
    if (!privateKey) {
      const fallbackKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
      privateKey = fallbackKeyBags[forge.pki.oids.keyBag]?.[0]?.key;
    }
    if (!privateKey) {
      throw new Error("No private key found in P12 certificate");
    }

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const allCerts: any[] = (certBags[forge.pki.oids.certBag] || [])
      .map((bag: any) => bag.cert)
      .filter((cert: any) => cert != null);
    if (allCerts.length === 0) {
      throw new Error("No certificates found in P12 file");
    }

    const signingCert = allCerts.find((cert: any) => {
      try {
        const certPublicKey = forge.pki.publicKeyToPem(cert.publicKey);
        const privatePublicKey = forge.pki.publicKeyToPem(
          forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e),
        );
        return certPublicKey === privatePublicKey;
      } catch {
        return false;
      }
    });
    if (!signingCert) {
      throw new Error(
        "Cannot identify signing certificate matching private key",
      );
    }

    const chainCerts = this.buildCertChain(signingCert, allCerts);
    this.logger.log(
      `P12 loaded: signing cert "${signingCert.subject.getField("CN")?.value}", ` +
        `chain depth: ${chainCerts.length}`,
    );

    const signingCertDer = Buffer.from(
      forge.asn1.toDer(forge.pki.certificateToAsn1(signingCert)).getBytes(),
      "binary",
    );
    const certHash = crypto
      .createHash("sha256")
      .update(signingCertDer)
      .digest();

    const essCertIdV2 = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.NULL,
              false,
              "",
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OCTETSTRING,
          false,
          certHash.toString("binary"),
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.SEQUENCE,
              true,
              [
                forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 4, true, [
                  this.dnToAsn1(signingCert.issuer),
                ]),
              ],
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.INTEGER,
              false,
              forge.util.hexToBytes(signingCert.serialNumber),
            ),
          ],
        ),
      ],
    );

    const signingCertificateV2Value = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [essCertIdV2],
        ),
      ],
    );

    const signedAttrs = forge.asn1.create(
      forge.asn1.Class.CONTEXT_SPECIFIC,
      0,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.9.3").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.SET,
              true,
              [
                forge.asn1.create(
                  forge.asn1.Class.UNIVERSAL,
                  forge.asn1.Type.OID,
                  false,
                  forge.asn1.oidToDer("1.2.840.113549.1.7.1").getBytes(),
                ),
              ],
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.9.5").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.SET,
              true,
              [
                forge.asn1.create(
                  forge.asn1.Class.UNIVERSAL,
                  forge.asn1.Type.UTCTIME,
                  false,
                  this.dateToUtcTime(new Date()),
                ),
              ],
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.9.4").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.SET,
              true,
              [
                forge.asn1.create(
                  forge.asn1.Class.UNIVERSAL,
                  forge.asn1.Type.OCTETSTRING,
                  false,
                  messageDigest.toString("binary"),
                ),
              ],
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.9.16.2.47").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.SET,
              true,
              [signingCertificateV2Value],
            ),
          ],
        ),
      ],
    );

    const signedAttrsForDigest = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SET,
      true,
      signedAttrs.value,
    );
    const signedAttrsDer = Buffer.from(
      forge.asn1.toDer(signedAttrsForDigest).getBytes(),
      "binary",
    );
    const md = forge.md.sha256.create();
    md.update(signedAttrsDer.toString("binary"));
    const signature = privateKey.sign(md, "RSASSA-PKCS1-V1_5");
    const certsAsn1 = chainCerts.map((cert: any) =>
      forge.pki.certificateToAsn1(cert),
    );

    const signerInfoAsn1 = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.INTEGER,
          false,
          forge.asn1.integerToDer(1).getBytes(),
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            this.dnToAsn1(signingCert.issuer),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.INTEGER,
              false,
              forge.util.hexToBytes(signingCert.serialNumber),
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.NULL,
              false,
              "",
            ),
          ],
        ),
        signedAttrs,
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.1.11").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.NULL,
              false,
              "",
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OCTETSTRING,
          false,
          signature,
        ),
      ],
    );

    const signedData = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.INTEGER,
          false,
          forge.asn1.integerToDer(1).getBytes(),
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SET,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.SEQUENCE,
              true,
              [
                forge.asn1.create(
                  forge.asn1.Class.UNIVERSAL,
                  forge.asn1.Type.OID,
                  false,
                  forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
                ),
                forge.asn1.create(
                  forge.asn1.Class.UNIVERSAL,
                  forge.asn1.Type.NULL,
                  false,
                  "",
                ),
              ],
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.7.1").getBytes(),
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.CONTEXT_SPECIFIC,
          0,
          true,
          certsAsn1,
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SET,
          true,
          [signerInfoAsn1],
        ),
      ],
    );

    const contentInfo = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer("1.2.840.113549.1.7.2").getBytes(),
        ),
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
          signedData,
        ]),
      ],
    );

    return Buffer.from(forge.asn1.toDer(contentInfo).getBytes(), "binary");
  }

  /**
   * Build an ordered certificate chain from signingCert up to root.
   * Returns [signingCert, intermediate(s)..., root] if available.
   */
  private buildCertChain(signingCert: any, allCerts: any[]): any[] {
    const chain: any[] = [signingCert];
    const maxDepth = 10;

    let current = signingCert;
    for (let i = 0; i < maxDepth; i++) {
      // Find issuer of current cert
      const issuer = allCerts.find(
        (c) =>
          c !== current &&
          c.subject.hash === current.issuer.hash &&
          !chain.includes(c),
      );
      if (!issuer) break;
      chain.push(issuer);
      // Self-signed root = stop
      if (issuer.subject.hash === issuer.issuer.hash) break;
      current = issuer;
    }

    return chain;
  }

  /**
   * Convert a forge Distinguished Name to ASN.1 (for use in IssuerSerial).
   */
  private dnToAsn1(dn: any): any {
    const forge = require("node-forge");
    // forge provides a utility to convert a DN to ASN.1
    return forge.pki.distinguishedNameToAsn1(dn);
  }

  /**
   * Format a Date as ASN.1 UTCTime string (YYMMDDHHMMSSZ).
   */
  private dateToUtcTime(date: Date): string {
    const y = date.getUTCFullYear().toString().slice(-2);
    const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
    const d = date.getUTCDate().toString().padStart(2, "0");
    const h = date.getUTCHours().toString().padStart(2, "0");
    const min = date.getUTCMinutes().toString().padStart(2, "0");
    const s = date.getUTCSeconds().toString().padStart(2, "0");
    return `${y}${m}${d}${h}${min}${s}Z`;
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
  private async embedTimestampInSignedPdf(signedPdf: Buffer): Promise<Buffer> {
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
    const forge = require("node-forge");
    const derReader = forge.util.createBuffer(
      derWithPadding.toString("binary"),
    );
    forge.asn1.fromDer(derReader, {
      strict: true,
      parseAllBytes: false,
      decodeBitStrings: true,
    });
    const cmsLength = derWithPadding.length - derReader.length();
    if (cmsLength <= 0) throw new Error("Empty CMS in PDF /Contents");
    const derCms = derWithPadding.subarray(0, cmsLength);

    const modifiedDer = await this.embedTimestampInCms(derCms);

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
  private async embedTimestampInCms(derCms: Buffer): Promise<Buffer> {
    const forge = require("node-forge");
    const contentInfo = forge.asn1.fromDer(derCms.toString("binary"));
    const signedDataContent = contentInfo.value[1];
    const signedData = signedDataContent.value[0];
    const signerInfosSet = signedData.value[signedData.value.length - 1];
    const signerInfo = signerInfosSet.value[0];

    let signatureValue: any = null;
    for (let i = 0; i < signerInfo.value.length; i++) {
      const item = signerInfo.value[i];
      if (item.type === forge.asn1.Type.OCTETSTRING && i >= 4) {
        signatureValue = item;
        break;
      }
    }
    if (!signatureValue) {
      throw new Error("Cannot find signature value in CMS SignerInfo");
    }

    const signatureBytes = Buffer.from(signatureValue.value, "binary");
    const messageImprint = crypto
      .createHash("sha256")
      .update(signatureBytes)
      .digest();
    const tsaResponse = await this.getTimestamp(messageImprint);
    if (!tsaResponse) {
      throw new Error("TSA returned no response");
    }

    const tsaAsn1 = forge.asn1.fromDer(tsaResponse.toString("binary"));
    const statusInfo = tsaAsn1.value[0];
    const statusValue = forge.asn1.derToInteger(statusInfo.value[0].value);
    if (statusValue !== 0 && statusValue !== 1) {
      throw new Error(`TSA returned non-granted status: ${statusValue}`);
    }
    if (tsaAsn1.value.length < 2) {
      throw new Error("TSA response missing TimeStampToken");
    }

    const timestampAttr = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer("1.2.840.113549.1.9.16.2.14").getBytes(),
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SET,
          true,
          [tsaAsn1.value[1]],
        ),
      ],
    );

    const lastItem = signerInfo.value[signerInfo.value.length - 1];
    const hasUnsignedAttrs =
      lastItem.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
      lastItem.type === 1;
    if (hasUnsignedAttrs) {
      lastItem.value.push(timestampAttr);
    } else {
      signerInfo.value.push(
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 1, true, [
          timestampAttr,
        ]),
      );
    }

    return Buffer.from(forge.asn1.toDer(contentInfo).getBytes(), "binary");
  }

  /**
   * Request a timestamp token from a TSA (RFC 3161).
   * Tries each configured TSA URL in order (primary -> fallback1 -> fallback2).
   * Required for the PAdES-B-T signature time-stamp attribute used here.
   *
   * Uses the native HTTPS module (NOT fetch) so that global-agent
   * can route the request through the configured HTTP_PROXY.
   */
  async getTimestamp(messageImprint: Buffer): Promise<Buffer | null> {
    if (this.tsaUrls.length === 0) return null;
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
        return tsResponse;
      } catch (error: any) {
        const msg = `TSA ${label} (${tsaUrl}) failed: ${error?.message}`;
        errors.push(msg);
        this.logger.warn(msg);
        // Continue to next fallback
      }
    }

    // All TSAs failed
    this.logger.error(
      `All ${this.tsaUrls.length} TSA(s) failed. Errors:\n  ${errors.join("\n  ")}`,
    );
    return null;
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

    const forge = require("node-forge");
    const nonce = crypto.randomBytes(8);
    // DER INTEGER is signed; keep this random 64-bit nonce positive and
    // non-zero so the exact value can be compared with TSTInfo.nonce.
    nonce[0] &= 0x7f;
    if (nonce.every((byte) => byte === 0)) nonce[nonce.length - 1] = 1;

    const messageImprintAsn1 = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
            ),
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.NULL,
              false,
              "",
            ),
          ],
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OCTETSTRING,
          false,
          messageImprint.toString("binary"),
        ),
      ],
    );
    const tsReq = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.INTEGER,
          false,
          forge.asn1.integerToDer(1).getBytes(),
        ),
        messageImprintAsn1,
        ...(this.tsaPolicyOid
          ? [
              forge.asn1.create(
                forge.asn1.Class.UNIVERSAL,
                forge.asn1.Type.OID,
                false,
                forge.asn1.oidToDer(this.tsaPolicyOid).getBytes(),
              ),
            ]
          : []),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.INTEGER,
          false,
          nonce.toString("binary"),
        ),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.BOOLEAN,
          false,
          String.fromCharCode(0xff),
        ),
      ],
    );

    return {
      body: Buffer.from(forge.asn1.toDer(tsReq).getBytes(), "binary"),
      nonce,
    };
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
    const forge = require("node-forge");
    const asn1 = forge.asn1.fromDer(response.toString("binary"), true);
    if (
      asn1.tagClass !== forge.asn1.Class.UNIVERSAL ||
      asn1.type !== forge.asn1.Type.SEQUENCE ||
      !Array.isArray(asn1.value) ||
      asn1.value.length !== 2
    ) {
      throw new Error("Invalid RFC 3161 TimeStampResp structure");
    }

    const statusInfo = asn1.value[0];
    const status = forge.asn1.derToInteger(statusInfo.value?.[0]?.value);
    if (status !== 0 && status !== 1) {
      throw new Error(`TSA returned non-granted status: ${status}`);
    }

    const contentInfo = asn1.value[1];
    const contentType = this.asn1Oid(contentInfo.value?.[0]);
    if (contentType !== "1.2.840.113549.1.7.2") {
      throw new Error("TimeStampToken is not CMS SignedData");
    }

    const signedData = contentInfo.value?.[1]?.value?.[0];
    if (!signedData || !Array.isArray(signedData.value)) {
      throw new Error("TimeStampToken SignedData is missing");
    }

    const encapContentInfo = signedData.value[2];
    if (
      this.asn1Oid(encapContentInfo?.value?.[0]) !== "1.2.840.113549.1.9.16.1.4"
    ) {
      throw new Error("TimeStampToken eContentType is not id-ct-TSTInfo");
    }
    const eContent = encapContentInfo?.value?.[1]?.value?.[0];
    const tstInfoDer = this.asn1Octets(eContent);
    if (tstInfoDer.length === 0)
      throw new Error("TimeStampToken TSTInfo is empty");

    const tstInfo = forge.asn1.fromDer(tstInfoDer.toString("binary"), true);
    if (forge.asn1.derToInteger(tstInfo.value?.[0]?.value) !== 1) {
      throw new Error("Unsupported TSTInfo version");
    }
    const policyOid = this.asn1Oid(tstInfo.value?.[1]);
    if (this.tsaPolicyOid && policyOid !== this.tsaPolicyOid) {
      throw new Error(
        `TSTInfo policy ${policyOid} does not match requested policy ${this.tsaPolicyOid}`,
      );
    }
    const imprint = tstInfo.value?.[2];
    const imprintAlgorithm = this.asn1Oid(imprint?.value?.[0]?.value?.[0]);
    const returnedImprint = this.asn1Octets(imprint?.value?.[1]);
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

    const serialNumber = this.normalizedIntegerHex(tstInfo.value?.[3]?.value);
    const generatedAt = forge.asn1.generalizedTimeToDate(
      tstInfo.value?.[4]?.value,
    );
    if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
      throw new Error("Invalid TSTInfo genTime");
    }

    const nonceNode = (tstInfo.value as any[])
      .slice(5)
      .find(
        (node: any) =>
          node.tagClass === forge.asn1.Class.UNIVERSAL &&
          node.type === forge.asn1.Type.INTEGER,
      );
    if (!nonceNode) throw new Error("TSTInfo nonce is missing");
    const returnedNonce = this.normalizedIntegerBytes(nonceNode.value);
    const normalizedExpectedNonce = this.normalizedIntegerBytes(
      expectedNonce.toString("binary"),
    );
    if (
      returnedNonce.length !== normalizedExpectedNonce.length ||
      !crypto.timingSafeEqual(returnedNonce, normalizedExpectedNonce)
    ) {
      throw new Error("TSTInfo nonce does not match the request");
    }

    const signerInfos = signedData.value[signedData.value.length - 1];
    if (
      signerInfos?.tagClass !== forge.asn1.Class.UNIVERSAL ||
      signerInfos?.type !== forge.asn1.Type.SET ||
      signerInfos.value?.length !== 1
    ) {
      throw new Error("TimeStampToken must contain exactly one TSA signature");
    }

    const certificates = signedData.value.find(
      (node: any, index: number) =>
        index > 2 &&
        node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
        node.type === 0,
    );
    if (!certificates || !Array.isArray(certificates.value)) {
      throw new Error("TSA certificate is missing despite certReq=true");
    }

    const signerInfo = signerInfos.value[0];
    const signedAttributes = signerInfo.value?.[3];
    if (
      signedAttributes?.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC ||
      signedAttributes?.type !== 0
    ) {
      throw new Error("TSA SignerInfo signed attributes are missing");
    }

    const digestAlgorithmOid = this.asn1Oid(signerInfo.value?.[2]?.value?.[0]);
    const digestName = this.digestNameForOid(digestAlgorithmOid);
    const contentTypeAttribute = this.findCmsAttribute(
      signedAttributes,
      "1.2.840.113549.1.9.3",
    );
    if (
      this.asn1Oid(contentTypeAttribute?.value?.[0]) !==
      "1.2.840.113549.1.9.16.1.4"
    ) {
      throw new Error("TSA signed content-type attribute is invalid");
    }
    const messageDigestAttribute = this.findCmsAttribute(
      signedAttributes,
      "1.2.840.113549.1.9.4",
    );
    const signedMessageDigest = this.asn1Octets(
      messageDigestAttribute?.value?.[0],
    );
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

    const certificateEntries = certificates.value.filter(
      (node: any) =>
        node.tagClass === forge.asn1.Class.UNIVERSAL &&
        node.type === forge.asn1.Type.SEQUENCE,
    );
    if (certificateEntries.length === 0)
      throw new Error("No X.509 TSA certificate found");

    const sid = signerInfo.value?.[1];
    let candidates = certificateEntries;
    let sidSerial = "";
    if (
      sid?.tagClass === forge.asn1.Class.UNIVERSAL &&
      sid?.type === forge.asn1.Type.SEQUENCE &&
      sid.value?.[1]
    ) {
      sidSerial = this.normalizedIntegerHex(sid.value[1].value);
      candidates = certificateEntries.filter((certificateAsn1: any) => {
        const certificate = forge.pki.certificateFromAsn1(certificateAsn1);
        // Compare ASN.1 INTEGER values byte-for-byte after removing only
        // sign-padding bytes. Do not strip hexadecimal characters: a valid
        // serial such as 01ab... must not become 1ab....
        const certificateSerial = this.normalizedIntegerHex(
          forge.util.hexToBytes(certificate.serialNumber),
        );
        return certificateSerial === sidSerial;
      });
    }
    if (candidates.length === 0)
      throw new Error("TSA signing certificate not found");

    const signedAttributesDer = Buffer.from(
      forge.asn1
        .toDer(
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.SET,
            true,
            signedAttributes.value,
          ),
        )
        .getBytes(),
      "binary",
    );
    const signatureAlgorithmOid = this.asn1Oid(
      signerInfo.value?.[4]?.value?.[0],
    );
    const signature = this.asn1Octets(signerInfo.value?.[5]);

    let verifiedCertificateAsn1: any = null;
    let verifiedCertificate: any = null;
    for (const candidate of candidates) {
      const certificateDer = Buffer.from(
        forge.asn1.toDer(candidate).getBytes(),
        "binary",
      );
      const x509 = new crypto.X509Certificate(certificateDer);
      const verificationKey =
        signatureAlgorithmOid === "1.2.840.113549.1.1.10"
          ? {
              key: x509.publicKey,
              padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
              saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO,
            }
          : x509.publicKey;
      if (
        crypto.verify(
          digestName,
          signedAttributesDer,
          verificationKey,
          signature,
        )
      ) {
        if (verifiedCertificateAsn1) {
          throw new Error("Ambiguous TSA signing certificate");
        }
        verifiedCertificateAsn1 = candidate;
        verifiedCertificate = forge.pki.certificateFromAsn1(candidate);
      }
    }
    if (!verifiedCertificateAsn1 || !verifiedCertificate) {
      throw new Error("TSA CMS signature verification failed");
    }

    const ekuExtensions = verifiedCertificate.extensions.filter(
      (extension: any) => extension.name === "extKeyUsage",
    );
    const eku = ekuExtensions[0];
    const ekuPurposes = eku
      ? Object.entries(eku)
          .filter(([key, value]) => value === true && key !== "critical")
          .map(([key]) => key)
      : [];
    if (
      ekuExtensions.length !== 1 ||
      eku.critical !== true ||
      eku.timeStamping !== true ||
      ekuPurposes.some((purpose: string) => purpose !== "timeStamping")
    ) {
      throw new Error(
        "TSA certificate lacks the exclusive critical timeStamping EKU",
      );
    }
    if (
      generatedAt < verifiedCertificate.validity.notBefore ||
      generatedAt > verifiedCertificate.validity.notAfter
    ) {
      throw new Error(
        "TSTInfo genTime is outside the TSA certificate validity period",
      );
    }

    const certificateDer = Buffer.from(
      forge.asn1.toDer(verifiedCertificateAsn1).getBytes(),
      "binary",
    );
    this.verifyEssCertificateIdentifier(signedAttributes, certificateDer);
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
        .update(certificateDer)
        .digest("hex"),
    };
  }

  private verifyTimestampCertificateTrust(
    signerCertificate: any,
    certificateEntries: any[],
    generatedAt: Date,
  ): void {
    if (this.tsaTrustedCertFingerprints.size === 0) return;

    const forge = require("node-forge");
    const certificates = certificateEntries.map((entry: any) =>
      forge.pki.certificateFromAsn1(entry),
    );
    let current = signerCertificate;
    const visited = new Set<string>();

    for (let depth = 0; depth < 10; depth++) {
      const der = Buffer.from(
        forge.asn1.toDer(forge.pki.certificateToAsn1(current)).getBytes(),
        "binary",
      );
      const fingerprint = crypto.createHash("sha256").update(der).digest("hex");
      if (visited.has(fingerprint)) break;
      visited.add(fingerprint);

      if (
        generatedAt < current.validity.notBefore ||
        generatedAt > current.validity.notAfter
      ) {
        throw new Error(
          "TSA certificate chain was not valid at TSTInfo genTime",
        );
      }
      if (this.tsaTrustedCertFingerprints.has(fingerprint)) return;

      const issuer = certificates.find((candidate: any) => {
        if (
          candidate === current ||
          candidate.subject.hash !== current.issuer.hash
        ) {
          return false;
        }
        try {
          return candidate.verify(current);
        } catch {
          return false;
        }
      });
      if (!issuer) break;
      current = issuer;
    }

    throw new Error(
      "TSA certificate chain does not reach a configured SHA-256 trust fingerprint",
    );
  }

  private findCmsAttribute(signedAttributes: any, oid: string): any {
    const attribute = signedAttributes.value?.find(
      (candidate: any) => this.asn1Oid(candidate.value?.[0]) === oid,
    );
    if (!attribute?.value?.[1])
      throw new Error(`Required CMS attribute missing: ${oid}`);
    return attribute.value[1];
  }

  private verifyEssCertificateIdentifier(
    signedAttributes: any,
    certificateDer: Buffer,
  ): void {
    const forge = require("node-forge");
    const v1 = signedAttributes.value?.find(
      (candidate: any) =>
        this.asn1Oid(candidate.value?.[0]) === "1.2.840.113549.1.9.16.2.12",
    );
    const v2 = signedAttributes.value?.find(
      (candidate: any) =>
        this.asn1Oid(candidate.value?.[0]) === "1.2.840.113549.1.9.16.2.47",
    );
    if (!v1 && !v2)
      throw new Error("TSA SigningCertificate/ESSCertID attribute is missing");

    let hashName = "sha1";
    let hashNode: any;
    if (v2) {
      const essCertId = v2.value?.[1]?.value?.[0]?.value?.[0]?.value?.[0];
      if (!essCertId)
        throw new Error("Malformed TSA SigningCertificateV2 attribute");
      if (essCertId.value?.[0]?.type === forge.asn1.Type.SEQUENCE) {
        hashName = this.digestNameForOid(
          this.asn1Oid(essCertId.value[0].value?.[0]),
        );
        hashNode = essCertId.value[1];
      } else {
        hashName = "sha256";
        hashNode = essCertId.value?.[0];
      }
    } else {
      const essCertId = v1.value?.[1]?.value?.[0]?.value?.[0]?.value?.[0];
      if (!essCertId)
        throw new Error("Malformed TSA SigningCertificate attribute");
      hashNode = essCertId.value?.[0];
    }

    const returnedHash = this.asn1Octets(hashNode);
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

  private asn1Oid(node: any): string {
    if (!node || typeof node.value !== "string") return "";
    const forge = require("node-forge");
    return forge.asn1.derToOid(node.value);
  }

  private asn1Octets(node: any): Buffer {
    if (!node) return Buffer.alloc(0);
    if (typeof node.value === "string")
      return Buffer.from(node.value, "binary");
    if (Array.isArray(node.value)) {
      return Buffer.concat(
        node.value.map((child: any) => this.asn1Octets(child)),
      );
    }
    return Buffer.alloc(0);
  }

  private normalizedIntegerBytes(value: string): Buffer {
    const bytes = Buffer.from(value || "", "binary");
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset++;
    return bytes.subarray(offset);
  }

  private normalizedIntegerHex(value: string): string {
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
  async generateCertificatePage(documentInfo: {
    documentId: string;
    fileName: string;
    signedAt: Date;
    signers: Array<{
      name: string;
      email: string;
      signedAt: Date;
      ip: string;
      signatureType: string;
      authenticationMethod?: string | null;
      identityVerificationMethod?: string | null;
      signingIntentHash?: string | null;
      signedDocumentHash?: string | null;
      webauthnUserVerified?: boolean | null;
    }>;
    documentHash: string;
    signatureLevel: string;
  }): Promise<Buffer> {
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4

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
    const identityLabel = (method?: string | null) => {
      if (method === "EMAIL_OTP") {
        return "Contrôle de l'adresse e-mail par code à usage unique";
      }
      if (method === "VERIFIED_EMAIL_ACCOUNT") {
        return "Compte PrivCloud avec adresse e-mail vérifiée";
      }
      if (method === "LDAP_ACCOUNT") return "Compte LDAP attribué";
      if (method === "OIDC_ACCOUNT") return "Compte OIDC attribué";
      return "Aucune preuve d'identité enregistrée";
    };

    const { width: _width, height } = page.getSize();
    let y = height - 60;

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
        `  Authentification: ${authenticationLabel(signer.authenticationMethod)}`,
        `  Preuve d'identité: ${identityLabel(signer.identityVerificationMethod)}`,
        ...(signer.webauthnUserVerified
          ? ["  Vérification locale WebAuthn: oui"]
          : []),
        ...(signer.signedDocumentHash
          ? [`  Empreinte source: ${signer.signedDocumentHash}`]
          : []),
        ...(signer.signingIntentHash
          ? [`  Empreinte du consentement: ${signer.signingIntentHash}`]
          : []),
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

    const levelSpecificLegalText = isReinforced
      ? [
          "Le niveau renforcé impose le compte PrivCloud attribué au destinataire et enregistre sa méthode",
          "de vérification. Chaque décision est confirmée par WebAuthn et liée à l'empreinte du document.",
          "Ces éléments renforcent la preuve de contrôle du compte, mais ne constituent pas à eux seuls",
          "une vérification d'identité civile par un prestataire qualifié. PrivCloud ne présente donc pas",
          "ce parcours comme une signature avancée conforme à l'article 26, ni comme une signature qualifiée.",
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
      "Lorsque l'horodatage est activé, seule l'empreinte SHA-256 de la valeur de signature est",
      "soumise à la TSA. La réponse RFC 3161 (empreinte, nonce, heure, signature et certificat TSA)",
      "est vérifiée avant que son jeton cryptographique soit incorporé au CMS/PDF, le document n'est",
      "alors finalisé que si ce jeton est valide, sauf dérogation serveur explicitement configurée.",
      "",
      "Le caractère qualifié de l'horodatage dépend du service TSA et du certificat effectivement employés,",
      "tels qu'inscritsdans la Trusted List applicable. Il ne résulte pas du seul protocole RFC 3161.",
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

    const { width: sigWidth, height: sigHeight } = signaturePage.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Add diagonal "Bon pour Accord" watermark on the WATERMARK page
    if (options.addApprovalWatermark && watermarkPage) {
      const { width: wmWidth, height: wmHeight } = watermarkPage.getSize();
      watermarkPage.drawText("Bon pour Accord", {
        x: wmWidth * 0.12,
        y: wmHeight * 0.38,
        size: 60,
        font: fontBold,
        color: rgb(0.5, 0.75, 0.5),
        opacity: 0.35,
        rotate: degrees(45),
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
    const nameText = signerInfo.name;

    const signatureBoxWidth = Math.min(
      Math.max(options.signatureField?.width || 240, 120),
      sigWidth,
    );
    const signatureBoxHeight = Math.min(
      Math.max(options.signatureField?.height || (addMention ? 90 : 70), 50),
      sigHeight,
    );
    const sigX = options.signatureField
      ? Math.min(
          Math.max(options.signatureField.posX || 0, 0),
          sigWidth - signatureBoxWidth,
        )
      : sigWidth - 260;
    const sigY = options.signatureField
      ? Math.min(
          Math.max(options.signatureField.posY || 0, 0),
          sigHeight - signatureBoxHeight,
        )
      : 110;
    const paddingX = 8;
    const paddingY = 8;
    let signatureImage: any = null;
    let signatureImageWidth = 0;
    let signatureImageHeight = 0;
    const signatureMaxWidth = Math.max(20, signatureBoxWidth - paddingX * 2);

    if (signerInfo.signatureImage) {
      signatureImage = await pdfDoc.embedPng(signerInfo.signatureImage);
      const sigDims = signatureImage.scale(0.5);
      signatureImageWidth = Math.min(sigDims.width, signatureMaxWidth, 180);
      signatureImageHeight = Math.min(
        sigDims.height,
        Math.max(28, signatureBoxHeight - (addMention ? 42 : 26)),
        40,
      );
    }

    const signatureTextWidth = signerInfo.signatureText
      ? Math.min(
          font.widthOfTextAtSize(signerInfo.signatureText, 14),
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
      : signerInfo.signatureText
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

    signaturePage.drawRectangle({
      x: contentPosition.x,
      y: contentPosition.y,
      width: contentWidth,
      height: contentHeight,
      color: rgb(1, 1, 1),
      opacity: 1,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 0.8,
    });

    if (addMention) {
      // "Lu et approuvé le ..."
      signaturePage.drawText(approvalText, {
        x: innerX,
        y: contentPosition.y + contentHeight - paddingY - 9,
        size: 9,
        font,
        color: rgb(0.15, 0.15, 0.15),
      });
    }

    // Signer name above signature
    signaturePage.drawText(nameText, {
      x: innerX,
      y: contentPosition.y + contentHeight - paddingY - (addMention ? 26 : 12),
      size: 10,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    if (signatureImage) {
      signaturePage.drawImage(signatureImage, {
        x: innerX,
        y: imageY,
        width: signatureImageWidth,
        height: signatureImageHeight,
      });
    } else if (signerInfo.signatureText) {
      // Text-based signature (italic style)
      signaturePage.drawText(signerInfo.signatureText, {
        x: innerX,
        y: imageY + 10,
        size: 14,
        font,
        color: rgb(0.1, 0.1, 0.5),
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
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
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
        const { width: pageWidth, height: pageHeight } = page.getSize();
        const boxWidth = Math.min(Math.max(field.width || 200, 80), pageWidth);
        const boxHeight = Math.min(
          Math.max(field.height || 42, 24),
          pageHeight,
        );
        const title =
          field.type === "APPROVAL"
            ? "Mention manuscrite"
            : field.type === "DATE"
              ? "Date"
              : field.label || "Texte";
        const x = Math.min(Math.max(field.posX || 0, 0), pageWidth - boxWidth);
        const y = Math.min(
          Math.max(field.posY || 0, 0),
          pageHeight - boxHeight,
        );
        const paddingX = 6;
        const paddingY = 6;
        const titleSize = 7;
        const valueSize = field.type === "APPROVAL" ? 9 : 8;
        const lineHeight = valueSize + 3;
        const value = fieldValue.value.trim();
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

        page.drawRectangle({
          x: contentPosition.x,
          y: contentPosition.y,
          width: contentWidth,
          height: contentHeight,
          color: rgb(1, 1, 1),
          opacity: 0.94,
          borderColor: rgb(0.55, 0.55, 0.55),
          borderWidth: 0.6,
        });

        page.drawText(title, {
          x: contentPosition.x + paddingX,
          y: contentPosition.y + contentHeight - paddingY - 7,
          size: titleSize,
          font: fontBold,
          color: rgb(0.32, 0.32, 0.32),
        });

        let textY = contentPosition.y + contentHeight - paddingY - 21;
        for (const line of visibleLines) {
          page.drawText(line, {
            x: contentPosition.x + paddingX,
            y: textY,
            size: valueSize,
            font,
            color: rgb(0.05, 0.05, 0.05),
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
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const initialsText = signerNames
      .map((name) =>
        name
          .split(" ")
          .map((w) => w[0]?.toUpperCase() || "")
          .join(""),
      )
      .join(" / ");

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
      const { width, height } = page.getSize();
      const fontSize = 9;
      const geometry = getInitialsStampGeometry({
        pageWidth: width,
        pageHeight: height,
        textWidth: font.widthOfTextAtSize(initialsText, fontSize),
        fontSize,
        placement: options.placement,
      });
      page.drawRectangle({
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        color: rgb(1, 1, 1),
        opacity: 0.94,
        borderColor: rgb(0.35, 0.35, 0.35),
        borderWidth: 0.6,
        borderOpacity: 0.75,
      });
      page.drawText(initialsText, {
        x: geometry.x + geometry.textXOffset,
        y: geometry.y + geometry.textYOffset,
        size: geometry.fontSize,
        font,
        color: rgb(0.12, 0.12, 0.12),
      });
    }

    return Buffer.from(await pdfDoc.save());
  }
}
