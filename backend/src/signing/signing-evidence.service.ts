import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SignatureRecipient } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";
import { FileService } from "src/file/file.service";
import { PdfSigningService } from "./pdf-signing.service";
import { appendSignatureAuditEvent } from "./signing-audit.util";
import {
  buildSignerContribution,
  buildSignerForensicRecord,
  canonicalJson,
  consentSha256For,
  EVIDENCE_BUNDLE_FORMAT,
  RECORDED_IN_FORENSIC_EVIDENCE,
  sha256Hex,
} from "./signing-evidence.util";

export const FORENSIC_EVIDENCE_FORMAT = "privcloud-forensic-evidence-v1";
const ATTESTATION_ENVELOPE_FORMAT = "privcloud-signing-evidence-envelope-v1";
const FORENSIC_ENVELOPE_FORMAT = "privcloud-forensic-evidence-envelope-v1";

/**
 * Two platform-signed objects are produced at finalization:
 * - the forensic dossier, kept by PrivCloud, holds everything that attributes
 *   each decision (network data, account identifiers, raw WebAuthn material,
 *   full audit trail);
 * - the attestation, distributed to the parties, holds only what they need
 *   and the hash of the forensic dossier and of each signer's record.
 */
@Injectable()
export class SigningEvidenceService {
  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
    private pdfSigningService: PdfSigningService,
  ) {}

  async createFinalEvidence(
    documentId: string,
    storedFinalDocument: Buffer,
    displayedFinalDocumentHash?: string,
  ) {
    const document = await this.prisma.signatureDocument.findUnique({
      where: { id: documentId },
      include: {
        recipients: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
        auditTrail: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        fields: { include: { fieldValues: true } },
      },
    });
    if (!document) throw new NotFoundException("Document not found");

    // Every signer of a multi-signer request approved the same source bytes.
    const sourceHashes = new Set(
      document.recipients
        .filter(
          (recipient) =>
            recipient.role === "SIGNER" &&
            recipient.status === "SIGNED" &&
            recipient.signedDocumentHash,
        )
        .map((recipient) => recipient.signedDocumentHash),
    );
    if (sourceHashes.size > 1) {
      throw new BadRequestException(
        "Signers approved different source documents",
      );
    }

    const generatedAt = new Date().toISOString();
    // Latest confirmation that the TSA was a granted qualified service.
    const tsaCheck = await this.prisma.trustedListCheck.findFirst({
      orderBy: { checkedAt: "desc" },
    });
    const tsaTrustedListCheck = tsaCheck
      ? {
          checkedAt: tsaCheck.checkedAt.toISOString(),
          listUrl: tsaCheck.listUrl,
          listSha256: tsaCheck.listSha256,
          sequenceNumber: tsaCheck.sequenceNumber,
          result: tsaCheck.result,
        }
      : null;
    const storedFinalDocumentHash = sha256Hex(storedFinalDocument);
    const finalDocumentHash =
      displayedFinalDocumentHash?.toLowerCase() || storedFinalDocumentHash;
    const documentSummary = {
      id: document.id,
      fileName: document.fileName,
      signatureLevel: document.signatureLevel,
      sourceSha256: [...sourceHashes][0] || null,
      finalSha256: finalDocumentHash,
      storedObjectSha256: storedFinalDocumentHash,
      encryptedEndToEnd: document.isE2EEncrypted,
      requestCreatedAt: document.createdAt.toISOString(),
      requestExpiresAt: document.expiresAt?.toISOString() || null,
    };

    const signers = document.recipients.map((recipient) => {
      const acted = ["SIGNED", "REJECTED"].includes(recipient.status);
      const record = acted ? this.recordOf(recipient) : null;
      return {
        recipient,
        record,
        appliedContribution:
          recipient.status === "SIGNED"
            ? buildSignerContribution({
                signatureType: recipient.signatureType,
                signatureData: recipient.signatureData,
                fieldValues: document.fields.flatMap((field) =>
                  field.fieldValues.filter(
                    (value) => value.recipientId === recipient.id,
                  ),
                ),
              })
            : null,
      };
    });

    const forensicPayload = {
      format: FORENSIC_EVIDENCE_FORMAT,
      generatedAt,
      document: documentSummary,
      tsaTrustedListCheck: tsaCheck
        ? { ...tsaTrustedListCheck, trace: tsaCheck.trace }
        : null,
      signers: signers.map(({ recipient, record, appliedContribution }) => ({
        recipientId: recipient.id,
        evidenceId: record?.evidenceId ?? null,
        role: recipient.role,
        status: recipient.status,
        forensicRecordSha256: record?.sha256 ?? null,
        // Records created before this format existed are rebuilt from the
        // persisted columns at finalization and flagged as such.
        recordFrozenAtAction: record?.frozenAtAction ?? null,
        forensicRecord: record ? JSON.parse(record.record) : null,
        appliedContribution,
      })),
      auditTrail: document.auditTrail.map((event) => ({
        id: event.id,
        type: event.eventType,
        actor: event.actor,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
        previousEventHash: event.previousEventHash,
        eventHash: event.eventHash,
      })),
    };
    const forensicBytes = Buffer.from(canonicalJson(forensicPayload), "utf8");
    const forensicSha256 = sha256Hex(forensicBytes);

    const attestationPayload = {
      format: EVIDENCE_BUNDLE_FORMAT,
      generatedAt,
      document: documentSummary,
      tsaTrustedListCheck,
      forensicEvidenceSha256: forensicSha256,
      signers: signers.map(({ recipient, record, appliedContribution }) => ({
        recipientId: recipient.id,
        evidenceId: record?.evidenceId ?? null,
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        status: recipient.status,
        signedAt: recipient.signedAt?.toISOString() || null,
        authenticationMethod: recipient.authenticationMethod,
        identityVerificationMethod: recipient.identityVerificationMethod,
        accountAssigned: Boolean(recipient.userId),
        webauthnUserVerified: recipient.webauthnUserVerified ?? null,
        transactionBound: Boolean(recipient.webauthnTransactionManifest),
        documentSha256: recipient.signedDocumentHash,
        intentSha256: recipient.signingIntentHash,
        consentSha256:
          recipient.status === "SIGNED"
            ? consentSha256For("SIGN")
            : recipient.status === "REJECTED"
              ? consentSha256For("REJECT")
              : null,
        appliedContribution,
        ipAddress: record ? RECORDED_IN_FORENSIC_EVIDENCE : null,
        forensicRecordSha256: record?.sha256 ?? null,
      })),
      // Hashes only: the events themselves, with network data, stay in the
      // forensic dossier whose hash is above.
      auditTrail: document.auditTrail.map((event) => ({
        id: event.id,
        type: event.eventType,
        createdAt: event.createdAt.toISOString(),
        previousEventHash: event.previousEventHash,
        eventHash: event.eventHash,
      })),
    };
    const attestationBytes = Buffer.from(
      canonicalJson(attestationPayload),
      "utf8",
    );

    const [forensicSignature, attestationSignature] = await Promise.all([
      this.pdfSigningService.signDigest(Buffer.from(forensicSha256, "hex"), {
        scope: "forensic",
        documentId,
      }),
      this.pdfSigningService.signDigest(
        Buffer.from(sha256Hex(attestationBytes), "hex"),
        { scope: "attestation", documentId },
      ),
    ]);
    const keys = {
      forensicEvidenceKey: `evidence/${documentId}/forensic.json`,
      forensicEvidenceSignatureKey: `evidence/${documentId}/forensic.p7s`,
      evidenceJsonKey: `evidence/${documentId}/evidence.json`,
      evidenceSignatureKey: `evidence/${documentId}/evidence.p7s`,
    };
    await this.fileService.storeFileByKey(keys.forensicEvidenceKey, forensicBytes);
    await this.fileService.storeFileByKey(
      keys.forensicEvidenceSignatureKey,
      forensicSignature,
    );
    await this.fileService.storeFileByKey(keys.evidenceJsonKey, attestationBytes);
    await this.fileService.storeFileByKey(
      keys.evidenceSignatureKey,
      attestationSignature,
    );

    await this.prisma.signatureDocument.update({
      where: { id: documentId },
      data: {
        ...keys,
        forensicEvidenceSha256: forensicSha256,
        finalDocumentHash,
      },
    });
    return { ...keys, finalDocumentHash, forensicEvidenceSha256: forensicSha256 };
  }

  /** The attestation shared with the parties of the request. */
  async getEvidenceEnvelope(documentId: string, userId: string) {
    const document = await this.prisma.signatureDocument.findFirst({
      where: {
        id: documentId,
        OR: [{ creatorId: userId }, { recipients: { some: { userId } } }],
      },
    });
    if (!document) throw new NotFoundException("Document not found");
    if (!document.evidenceJsonKey || !document.evidenceSignatureKey) {
      throw new BadRequestException("Final evidence is not available");
    }
    return {
      buffer: await this.envelope(
        ATTESTATION_ENVELOPE_FORMAT,
        document.evidenceJsonKey,
        document.evidenceSignatureKey,
        await this.timestampExchanges({ documentId }),
      ),
      fileName: document.fileName.replace(/\.pdf$/i, "") + ".attestation.json",
    };
  }

  /**
   * Right of access: a signer holding an account gets their own forensic
   * records for this request, never those of the other parties.
   */
  async getOwnForensicRecords(documentId: string, userId: string) {
    const recipients = await this.prisma.signatureRecipient.findMany({
      where: { documentId, userId, forensicRecord: { not: null } },
      select: {
        evidenceId: true,
        forensicRecord: true,
        forensicRecordSha256: true,
        document: { select: { fileName: true } },
      },
    });
    if (recipients.length === 0) {
      throw new NotFoundException("No forensic record for this account");
    }
    return {
      buffer: Buffer.from(
        JSON.stringify(
          {
            format: "privcloud-signer-forensic-export-v1",
            records: recipients.map((recipient) => ({
              evidenceId: recipient.evidenceId,
              forensicRecordSha256: recipient.forensicRecordSha256,
              // The exact canonical bytes whose hash appears in the PDF.
              forensicRecordCanonical: recipient.forensicRecord,
            })),
          },
          null,
          2,
        ),
      ),
      fileName:
        recipients[0].document.fileName.replace(/\.pdf$/i, "") +
        ".my-forensic-record.json",
    };
  }

  /**
   * Complete forensic dossier for an instance administrator, for a dispute or
   * a legal request. Every export is appended to the audit trail.
   */
  async getForensicEnvelopeForAdmin(documentId: string, adminEmail: string) {
    const document = await this.prisma.signatureDocument.findUnique({
      where: { id: documentId },
    });
    if (!document) throw new NotFoundException("Document not found");
    if (
      !document.forensicEvidenceKey ||
      !document.forensicEvidenceSignatureKey
    ) {
      throw new BadRequestException("Forensic evidence is not available");
    }
    await appendSignatureAuditEvent(this.prisma, {
      documentId,
      eventType: "FORENSIC_EVIDENCE_EXPORTED",
      actor: adminEmail,
    });
    const credentialIds = (
      await this.prisma.signatureRecipient.findMany({
        where: { documentId, webauthnCredentialId: { not: null } },
        select: { webauthnCredentialId: true },
      })
    ).map((recipient) => recipient.webauthnCredentialId!);
    return {
      buffer: await this.envelope(
        FORENSIC_ENVELOPE_FORMAT,
        document.forensicEvidenceKey,
        document.forensicEvidenceSignatureKey,
        await this.timestampExchanges({ documentId, credentialIds }),
      ),
      fileName: document.fileName.replace(/\.pdf$/i, "") + ".forensic.json",
    };
  }

  private recordOf(recipient: SignatureRecipient) {
    if (
      recipient.evidenceId &&
      recipient.forensicRecord &&
      recipient.forensicRecordSha256
    ) {
      return {
        evidenceId: recipient.evidenceId,
        record: recipient.forensicRecord,
        sha256: recipient.forensicRecordSha256,
        frozenAtAction: true,
      };
    }
    const evidenceId = `LEGACY-${recipient.id}`;
    const { record, sha256 } = buildSignerForensicRecord({
      evidenceId,
      documentId: recipient.documentId,
      recipientId: recipient.id,
      action: recipient.status === "REJECTED" ? "REJECT" : "SIGN",
      actedAt: recipient.signedAt || recipient.updatedAt,
      signer: {
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        privcloudUserId: recipient.userId,
      },
      identity: {
        verificationMethod: recipient.identityVerificationMethod,
        verifiedAt: recipient.identityVerifiedAt,
        accountSnapshot: recipient.webauthnIdentitySnapshot,
      },
      network: {
        ipAddress: recipient.signingIp,
        userAgent: recipient.signingUserAgent,
      },
      evidence: recipient,
    });
    return { evidenceId, record, sha256, frozenAtAction: false };
  }

  /**
   * Raw RFC 3161 exchanges of the seals covering this request. They travel
   * outside the signed payload: the tokens they hold are signed by the TSA.
   */
  private async timestampExchanges(filter: {
    documentId: string;
    credentialIds?: string[];
  }) {
    const exchanges = await this.prisma.signingTimestamp.findMany({
      where: {
        OR: [
          { documentId: filter.documentId },
          ...(filter.credentialIds?.length
            ? [
                {
                  scope: "enrollment",
                  webauthnCredentialId: { in: filter.credentialIds },
                },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    return exchanges.map((exchange) => ({
      scope: exchange.scope,
      messageImprint: exchange.messageImprint,
      tsaUrl: exchange.tsaUrl,
      requestBase64: exchange.requestBase64,
      responseBase64: exchange.responseBase64,
    }));
  }

  private async envelope(
    format: string,
    payloadKey: string,
    signatureKey: string,
    timestampExchanges: unknown[],
  ) {
    const [payload, signature] = await Promise.all([
      this.fileService.getFileByKey(payloadKey),
      this.fileService.getFileByKey(signatureKey),
    ]);
    return Buffer.from(
      JSON.stringify(
        {
          format,
          payloadCanonicalBase64: payload.toString("base64"),
          platformSignatureCmsBase64: signature.toString("base64"),
          timestampExchanges,
        },
        null,
        2,
      ),
    );
  }
}
