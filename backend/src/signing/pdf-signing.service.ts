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
  private tsaUrls: string[];

  constructor() {
    this.certificatePath =
      process.env.SIGNING_CERTIFICATE_PATH ||
      path.join(process.cwd(), "data", "signing", "certificate.p12");
    this.certificatePassword =
      process.env.SIGNING_CERTIFICATE_PASSWORD || "";

    // Build TSA URL list: primary + up to 2 fallbacks
    const primary = process.env.SIGNING_TSA_URL || "https://freetsa.org/tsr";
    const fallback1 = process.env.SIGNING_TSA_URL_FALLBACK_1 || "";
    const fallback2 = process.env.SIGNING_TSA_URL_FALLBACK_2 || "";

    this.tsaUrls = [primary, fallback1, fallback2]
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    // Reject HTTP TSA URLs in production - timestamps must be fetched over TLS
    if (process.env.NODE_ENV === "production") {
      const insecure = this.tsaUrls.filter((u) => !u.startsWith("https://"));
      if (insecure.length > 0) {
        this.logger.error(
          `TSA URLs using insecure HTTP removed: ${insecure.join(", ")}. ` +
          "Set all SIGNING_TSA_URL* to HTTPS endpoints.",
        );
        this.tsaUrls = this.tsaUrls.filter((u) => u.startsWith("https://"));
      }
    }

    if (this.tsaUrls.length > 0) {
      this.logger.log(
        `TSA configured: ${this.tsaUrls[0]}` +
        (this.tsaUrls.length > 1 ? ` (+${this.tsaUrls.length - 1} fallback)` : ""),
      );
    }
  }

  /**
   * Sign a PDF buffer with a PAdES-B-T signature (with RFC 3161 timestamp).
   * Uses @signpdf/placeholder-pdf-lib for the /Sig placeholder, then builds
   * a full CMS/PKCS#7 SignedData manually (node-forge) with:
   * - signingCertificateV2 (OID 1.2.840.113549.1.9.16.2.47) in signed attributes
   * - Full certificate chain from the P12
   * - Proper ByteRange handling and PAdES-B-T compliance
   *
   * If no certificate is configured, the PDF is returned with explicit
   * "UNSIGNED" metadata - no false guarantees.
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
        "No signing certificate found at " + this.certificatePath + ". " +
        "Cannot produce a cryptographically signed PDF. " +
        "Configure SIGNING_CERTIFICATE_PATH to a .p12/.pfx file.";
      this.logger.error(msg);
      throw new Error(msg);
    }

    const reason =
      signerInfo.reason || "Document signé électroniquement via PrivCloud Sharing";
    const location = signerInfo.location || "PrivCloud Sharing Platform";

    try {
      // 1. Load the PDF with pdf-lib and add a signature placeholder
      const { PDFDocument } = await import("pdf-lib");
      const { pdflibAddPlaceholder } = await import("@signpdf/placeholder-pdf-lib");

      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Set metadata
      pdfDoc.setProducer("PrivCloud Sharing - Signature Électronique eIDAS PAdES-B-T");
      pdfDoc.setCreator("PrivCloud Sharing SAAS");

      // Add the /Sig placeholder - signatureLength is in hex chars (2 per byte)
      // 32768 hex chars = 16384 bytes capacity for CMS + TSA timestamp token
      pdflibAddPlaceholder({
        pdfDoc,
        reason,
        location,
        name: signerInfo.name,
        contactInfo: signerInfo.email,
        signatureLength: 32768,
      });

      // Serialize the PDF with the placeholder in place
      const pdfWithPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

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
          this.logger.warn(
            `TSA timestamp embedding failed: ${tsaError?.message}. ` +
            "PDF remains signed at PAdES-B-B level (no timestamp).",
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
        "No signing certificate found at " + this.certificatePath + ". " +
        "Cannot produce a cryptographic signature.";
      this.logger.error(msg);
      throw new Error(msg);
    }

    try {
      let cmsDer = this.buildPadesCms(messageDigest, p12Buffer);

      if (this.tsaUrls.length > 0) {
        try {
          cmsDer = await this.embedTimestampInCms(cmsDer);
          this.logger.log(`Detached PAdES-B-T CMS created (${cmsDer.length} bytes)`);
        } catch (tsaError: any) {
          this.logger.warn(
            `TSA timestamp embedding failed: ${tsaError?.message}. ` +
            "CMS remains signed at PAdES-B-B level.",
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
   * Required for PAdES-B-T compliance and proper eIDAS validation.
   */
  private signPdfWithPadesCms(pdfWithPlaceholder: Buffer, p12Buffer: Buffer): Buffer {
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
    const innerPadded = byteRangeValues.padEnd(byteRangeInnerContent.length, " ");
    const byteRangeReplacement = `/ByteRange [${innerPadded}]`;

    // Verify same byte length (critical - positions must not shift)
    if (byteRangeReplacement.length !== byteRangeFullMatch.length) {
      throw new Error(
        `ByteRange replacement length mismatch: ${byteRangeReplacement.length} vs ${byteRangeFullMatch.length}`,
      );
    }

    // Patch ByteRange into the PDF buffer
    const pdfBuf = Buffer.from(pdfWithPlaceholder);
    pdfBuf.write(byteRangeReplacement, byteRangeStart, byteRangeReplacement.length, "latin1");

    // --- Step 4: Extract data to sign (everything except the hex content between < >) ---
    const dataToSign = Buffer.concat([
      pdfBuf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      pdfBuf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);

    // --- Step 5: Compute message digest ---
    const messageDigest = crypto.createHash("sha256").update(dataToSign).digest();

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

    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
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
      throw new Error("Cannot identify signing certificate matching private key");
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
    const certHash = crypto.createHash("sha256").update(signingCertDer).digest();

    const essCertIdV2 = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
        ]),
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OCTETSTRING,
          false,
          certHash.toString("binary"),
        ),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 4, true, [
              this.dnToAsn1(signingCert.issuer),
            ]),
          ]),
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.INTEGER,
            false,
            forge.util.hexToBytes(signingCert.serialNumber),
          ),
        ]),
      ],
    );

    const signingCertificateV2Value = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          essCertIdV2,
        ]),
      ],
    );

    const signedAttrs = forge.asn1.create(
      forge.asn1.Class.CONTEXT_SPECIFIC,
      0,
      true,
      [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("1.2.840.113549.1.9.3").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("1.2.840.113549.1.7.1").getBytes(),
            ),
          ]),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("1.2.840.113549.1.9.5").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.UTCTIME,
              false,
              this.dateToUtcTime(new Date()),
            ),
          ]),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("1.2.840.113549.1.9.4").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OCTETSTRING,
              false,
              messageDigest.toString("binary"),
            ),
          ]),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("1.2.840.113549.1.9.16.2.47").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
            signingCertificateV2Value,
          ]),
        ]),
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
    const certsAsn1 = chainCerts.map((cert: any) => forge.pki.certificateToAsn1(cert));

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
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          this.dnToAsn1(signingCert.issuer),
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.INTEGER,
            false,
            forge.util.hexToBytes(signingCert.serialNumber),
          ),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
        ]),
        signedAttrs,
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("1.2.840.113549.1.1.11").getBytes(),
          ),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
        ]),
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
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.OID,
              false,
              forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes(),
            ),
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
          ]),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer("1.2.840.113549.1.7.1").getBytes(),
          ),
        ]),
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, certsAsn1),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
          signerInfoAsn1,
        ]),
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
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData]),
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
      const issuer = allCerts.find((c) =>
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

    // 2. Decode hex -> DER (strip trailing zero padding)
    const derWithPadding = Buffer.from(hexSignature, "hex");
    // Find actual end of ASN.1 structure (strip trailing 0x00 bytes)
    let derEnd = derWithPadding.length;
    while (derEnd > 0 && derWithPadding[derEnd - 1] === 0x00) {
      derEnd--;
    }
    const derCms = derWithPadding.slice(0, derEnd);

    const modifiedDer = await this.embedTimestampInCms(derCms);

    // Verify it fits in the placeholder
    const maxSize = hexSignature.length / 2; // original placeholder size in bytes
    if (modifiedDer.length > maxSize) {
      throw new Error(
        `Timestamped CMS (${modifiedDer.length} bytes) exceeds placeholder (${maxSize} bytes)`,
      );
    }

    // 10. Hex-encode with zero-padding to fill the placeholder
    const modifiedHex = modifiedDer.toString("hex").padEnd(hexSignature.length, "0");

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
        forge.asn1.create(
          forge.asn1.Class.CONTEXT_SPECIFIC,
          1,
          true,
          [timestampAttr],
        ),
      );
    }

    return Buffer.from(forge.asn1.toDer(contentInfo).getBytes(), "binary");
  }

  /**
   * Request a timestamp token from a TSA (RFC 3161).
   * Tries each configured TSA URL in order (primary -> fallback1 -> fallback2).
   * Required for PAdES-B-T and PAdES-B-LT long-term validation.
   *
   * Uses the native https/http module (NOT fetch) so that global-agent
   * can route the request through the configured HTTP_PROXY.
   */
  async getTimestamp(messageImprint: Buffer): Promise<Buffer | null> {
    if (this.tsaUrls.length === 0) return null;

    // Build a TimeStampReq (RFC 3161) using node-forge ASN.1
    const forge = require("node-forge");
    const nonce = crypto.randomBytes(8);

    const tsReq = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      // version INTEGER 1
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
        forge.asn1.integerToDer(1).getBytes()),
      // messageImprint SEQUENCE
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        // hashAlgorithm AlgorithmIdentifier for SHA-256
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
            forge.asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes()), // SHA-256
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
        ]),
        // hashedMessage OCTET STRING
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false,
          messageImprint.toString("binary")),
      ]),
      // nonce INTEGER (replay protection)
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
        nonce.toString("binary")),
      // certReq BOOLEAN TRUE (request TSA cert in response for validation)
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BOOLEAN, false,
        String.fromCharCode(0xff)),
    ]);

    const tsReqBody = Buffer.from(forge.asn1.toDer(tsReq).getBytes(), "binary");

    // Try each TSA URL in sequence until one succeeds
    const errors: string[] = [];

    for (let i = 0; i < this.tsaUrls.length; i++) {
      const tsaUrl = this.tsaUrls[i];
      const label = i === 0 ? "primary" : `fallback-${i}`;

      try {
        const tsResponse = await this.requestTsa(tsaUrl, tsReqBody);
        this.logger.log(
          `Timestamp token obtained from TSA ${label}: ${tsaUrl}`,
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
   * Send a single TimeStampReq to a specific TSA URL.
   * Uses native https/http module (patched by global-agent for proxy support).
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
      const httpModule = require("https");

      const req = httpModule.request(
        tsaUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/timestamp-query",
            "Content-Length": tsReqBody.length,
          },
          timeout: 10_000, // 10s per TSA attempt
        },
        (res: any) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
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

    const { width: _width, height } = page.getSize();
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
      "Ce document a fait l’objet d’une signature électronique avancée intégrant des mécanismes d’horodatage,",
      "d’intégrité cryptographique et de traçabilité conformément aux principes définis par",
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
    const { PDFDocument, rgb, StandardFonts, degrees } = await import("pdf-lib");

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
      ? Math.min(Math.max(options.signatureField.posX || 0, 0), sigWidth - signatureBoxWidth)
      : sigWidth - 260;
    const sigY = options.signatureField
      ? Math.min(Math.max(options.signatureField.posY || 0, 0), sigHeight - signatureBoxHeight)
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
      ? Math.min(font.widthOfTextAtSize(signerInfo.signatureText, 14), signatureMaxWidth)
      : 0;
    const approvalWidth = addMention
      ? Math.min(font.widthOfTextAtSize(approvalText, 9), signatureMaxWidth)
      : 0;
    const nameWidth = Math.min(fontBold.widthOfTextAtSize(nameText, 10), signatureMaxWidth);
    const visualSignatureHeight = signatureImage
      ? signatureImageHeight
      : signerInfo.signatureText
        ? 18
        : 24;

    const contentWidth = Math.min(
      signatureBoxWidth,
      Math.max(80, approvalWidth, nameWidth, signatureImageWidth, signatureTextWidth) + paddingX * 2,
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
        const boxHeight = Math.min(Math.max(field.height || 42, 24), pageHeight);
        const title =
          field.type === "APPROVAL"
            ? "Mention manuscrite"
            : field.type === "DATE"
              ? "Date"
              : field.label || "Texte";
        const x = Math.min(Math.max(field.posX || 0, 0), pageWidth - boxWidth);
        const y = Math.min(Math.max(field.posY || 0, 0), pageHeight - boxHeight);
        const paddingX = 6;
        const paddingY = 6;
        const titleSize = 7;
        const valueSize = field.type === "APPROVAL" ? 9 : 8;
        const lineHeight = valueSize + 3;
        const value = fieldValue.value.trim();
        const lines = this.wrapPdfText(value, Math.max(20, boxWidth - paddingX * 2), valueSize);
        const visibleLines = lines.slice(
          0,
          Math.max(1, Math.floor((boxHeight - paddingY * 2 - 14) / lineHeight)),
        );
        const textWidth = Math.max(
          fontBold.widthOfTextAtSize(title, titleSize),
          ...visibleLines.map((line) => font.widthOfTextAtSize(line, valueSize)),
          40,
        );
        const contentWidth = Math.min(boxWidth, textWidth + paddingX * 2);
        const contentHeight = Math.min(
          boxHeight,
          Math.max(24, paddingY * 2 + 10 + 4 + visibleLines.length * lineHeight),
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

  private wrapPdfText(text: string, maxWidth: number, fontSize: number): string[] {
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
