import {
  BadRequestException,
  ForbiddenException,
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
import {
  CreateSignatureRequestDTO,
  SignatureLevel,
} from "./dto/createSignatureRequest.dto";
import { SignDocumentDTO } from "./dto/signDocument.dto";
import { User } from "@prisma/client";
import { deliverSigningCompletionEmails } from "./signing-mail.util";

@Injectable()
export class SigningService {
  private readonly logger = new Logger(SigningService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private fileService: FileService,
    private configService: ConfigService,
    private pdfSigningService: PdfSigningService,
  ) {}

  /**
   * Create a signature request for a PDF file within a share.
   * Sends email notifications to all recipients.
   */
  async createSignatureRequest(dto: CreateSignatureRequestDTO, user: User) {
    let share: any;
    let file: any;

    if (dto.teamId) {
      // --- Team context: verify membership + share belongs to team folder ---
      const membership = await this.prisma.teamMember.findFirst({
        where: { teamId: dto.teamId, userId: user.id, isActive: true },
      });
      if (!membership) {
        throw new ForbiddenException(
          "You are not an active member of this team",
        );
      }

      // Find the share within any team folder of this team
      share = await this.prisma.share.findFirst({
        where: {
          id: dto.shareId,
          teamFolder: { teamId: dto.teamId },
        },
        include: { files: true },
      });
      if (!share) {
        throw new ForbiddenException(
          "This share does not belong to the specified team",
        );
      }

      // SECURITY: Only OWNER/ADMIN or members with explicit canRequestSignature
      // permission on the EXACT folder containing this share are allowed.
      // Also accept per-file FileAccess overrides (canRequestSignature).
      if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
        const folderAccess = await this.prisma.teamFolderAccess.findFirst({
          where: {
            memberId: membership.id,
            folderId: share.teamFolderId,
            canRequestSignature: true,
          },
        });
        // Also check per-file override (FileAccess overrides folder-level rules)
        const fileAccess = dto.fileId
          ? await this.prisma.fileAccess.findFirst({
              where: {
                memberId: membership.id,
                fileId: dto.fileId,
                canRequestSignature: true,
              },
            })
          : null;
        if (!folderAccess && !fileAccess) {
          throw new ForbiddenException(
            "You do not have permission to request signatures in this folder",
          );
        }
      }

      file = share.files.find((f: any) => f.id === dto.fileId);
      if (!file) {
        throw new NotFoundException("File not found in this share");
      }
    } else {
      // --- Personal context: share must belong to user ---
      share = await this.prisma.share.findFirst({
        where: { id: dto.shareId, creatorId: user.id },
        include: { files: true },
      });
      if (!share) {
        throw new NotFoundException("Share not found or access denied");
      }

      file = share.files.find((f: any) => f.id === dto.fileId);
      if (!file) {
        throw new NotFoundException("File not found in this share");
      }
    }

    // Verify it's a PDF
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      throw new BadRequestException(
        "Electronic signatures are only supported for PDF files",
      );
    }

    if (dto.addApprovalField === false && dto.watermarkPage !== undefined) {
      throw new BadRequestException(
        "Watermark page cannot be set when the approval watermark is disabled",
      );
    }

    const addApprovalField = dto.addApprovalField ?? true;

    this.validateSignatureFields(dto);

    // Create the signature document
    let document = await this.prisma.signatureDocument.create({
      data: {
        fileName: file.name,
        title: file.name,
        fileKey: `${dto.shareId}/${file.id}`,
        originalFileKey: `${dto.shareId}/${file.id}`,
        status: "PENDING",
        message: dto.message,
        signatureLevel: dto.signatureLevel || SignatureLevel.AES,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        addApprovalField,
        addApprovalMention: dto.addApprovalMention ?? true,
        addInitials: dto.addInitials ?? false,
        signaturePage: dto.signaturePage ?? null,
        watermarkPage: addApprovalField ? (dto.watermarkPage ?? null) : null,
        isE2EEncrypted: dto.isE2EEncrypted ?? false,
        ownerId: user.id,
        creatorId: user.id,
        shareId: dto.shareId,
        fileId: dto.fileId,
        teamId: dto.teamId || null,
        recipients: {
          create: dto.recipients.map((r, idx) => ({
            email: r.email,
            name: r.name,
            role: r.role || "SIGNER",
            order: r.order ?? idx + 1,
            status: "PENDING",
          })),
        },
      },
      include: { recipients: true, fields: true },
    });

    if (dto.fields?.length) {
      const recipientByEmail = new Map(
        document.recipients.map((r) => [r.email.toLowerCase(), r.id]),
      );
      await this.prisma.signatureField.createMany({
        data: dto.fields.map((f, idx) => ({
          documentId: document.id,
          assignedRecipientId: f.assignedRecipientEmail
            ? recipientByEmail.get(f.assignedRecipientEmail.toLowerCase()) ||
              null
            : null,
          type: f.type,
          page: f.page ?? 1,
          posX: f.posX ?? 72,
          posY: f.posY ?? 200 + idx * 80,
          width: f.width ?? 200,
          height: f.height ?? 60,
          rotation: f.rotation || 0,
          label: f.label?.trim() || null,
          required: f.required ?? true,
        })),
      });

      document =
        (await this.prisma.signatureDocument.findUnique({
          where: { id: document.id },
          include: { recipients: true, fields: true },
        })) || document;
    }

    const shouldEmailE2EKey = Boolean(
      dto.isE2EEncrypted && dto.sendE2EKeyByEmail && dto.e2eKey,
    );

    // Create audit event
    await this.createAuditEvent(document.id, "CREATED", user.email);

    // Log team activity if this signature is for a team
    if (dto.teamId) {
      this.logger.log(`Logging SIGNATURE_REQUEST for team ${dto.teamId}`);
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: dto.teamId,
            action: "SIGNATURE_REQUEST",
            actorEmail: user.email,
            actorName: user.username || undefined,
            fileName: file.name,
            folderId: share.teamFolderId || undefined,
          },
        })
        .catch((err) =>
          this.logger.error(`Failed to log SIGNATURE_REQUEST: ${err.message}`),
        );
    }

    // Send emails to recipients (in order)
    const firstOrderRecipients = document.recipients.filter(
      (r) => r.order === 1 && r.role !== "CC",
    );

    let emailDeliveryFailures = 0;
    for (const recipient of firstOrderRecipients) {
      const sent = await this.sendSigningInvitation(document, recipient);
      if (!sent) emailDeliveryFailures++;
    }

    // Notify CC recipients
    const ccRecipients = document.recipients.filter((r) => r.role === "CC");
    for (const cc of ccRecipients) {
      const sent = await this.sendCcNotification(document, cc, user);
      if (!sent) emailDeliveryFailures++;
    }

    if (shouldEmailE2EKey && dto.e2eKey) {
      const keyRecipients = document.recipients.filter((r) => r.role !== "CC");
      for (const recipient of keyRecipients) {
        const sent = await this.sendE2EKeyEmail(
          document,
          recipient,
          dto.e2eKey,
        );
        if (!sent) emailDeliveryFailures++;
      }
    }

    this.logger.log(
      `Signature request created: docId=${document.id} by ${user.email} ` +
        `with ${document.recipients.length} recipients`,
    );

    return { ...document, emailDeliveryFailures };
  }

  /**
   * Get signature documents created by a user.
   * Enriches each document with a `fileDeleted` flag indicating whether the
   * source share has been removed since the signature request was created.
   */
  async getMyDocuments(userId: string) {
    const docs = await this.prisma.signatureDocument.findMany({
      where: { creatorId: userId },
      include: {
        recipients: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            signedAt: true,
            order: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return this.enrichWithFileDeleted(docs);
  }

  /**
   * Get documents where the current user is a recipient (signer/approver/CC).
   * Allows signers to see documents they've signed in their own space.
   */
  async getReceivedDocuments(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    const docs = await this.prisma.signatureDocument.findMany({
      where: {
        recipients: { some: { email: user.email } },
        creatorId: { not: userId }, // Exclude docs the user created (those are in getMyDocuments)
      },
      include: {
        recipients: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            signedAt: true,
            order: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return this.enrichWithFileDeleted(docs);
  }

  /**
   * Get all signature documents for a team.
   * Only accessible by team members (verified by the caller).
   */
  async getTeamDocuments(
    teamId: string,
    userId: string,
    options: { page?: number; limit?: number } = {},
  ) {
    // Verify user is a member of the team
    const membership = await this.prisma.teamMember.findFirst({
      where: { teamId, userId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException("You are not a member of this team");
    }

    // Only OWNER/ADMIN or members with canViewSignatures can list all team documents
    const isAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
    if (!isAdmin && !membership.canViewSignatures) {
      throw new ForbiddenException(
        "You do not have permission to view signatures",
      );
    }

    const page =
      Number.isFinite(options.page) && (options.page || 0) > 0
        ? Math.floor(options.page as number)
        : 1;
    const limit =
      Number.isFinite(options.limit) && (options.limit || 0) > 0
        ? Math.min(Math.floor(options.limit as number), 100)
        : 50;
    const where = { teamId };

    const [docs, total] = await Promise.all([
      this.prisma.signatureDocument.findMany({
        where,
        include: {
          recipients: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              status: true,
              signedAt: true,
              order: true,
            },
          },
          creator: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.signatureDocument.count({ where }),
    ]);

    return {
      documents: await this.enrichWithFileDeleted(docs),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a specific signature document with full details.
   */
  async getDocument(documentId: string, userId: string) {
    // Resolve user email for recipient lookup (recipients may not have userId set)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const doc = await this.prisma.signatureDocument.findFirst({
      where: {
        id: documentId,
        OR: [
          { creatorId: userId },
          { recipients: { some: { userId } } },
          ...(user?.email
            ? [{ recipients: { some: { email: user.email } } }]
            : []),
          // Team members (OWNER/ADMIN or canViewSignatures) can access team documents
          {
            teamId: { not: null },
            team: {
              members: {
                some: {
                  userId,
                  isActive: true,
                  OR: [
                    { role: "OWNER" },
                    { role: "ADMIN" },
                    { canViewSignatures: true },
                  ],
                },
              },
            },
          },
        ],
      },
      include: {
        recipients: true,
        fields: true,
        auditTrail: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!doc) throw new NotFoundException("Document not found");

    // For E2E documents, resolve teamId so frontend can derive the decryption key
    let teamId: string | null = null;
    if (doc.isE2EEncrypted && doc.shareId) {
      const share = await this.prisma.share.findUnique({
        where: { id: doc.shareId },
        select: { teamFolder: { select: { teamId: true } } },
      });
      teamId = share?.teamFolder?.teamId ?? null;
    }

    // Enrich with fileDeleted flag
    const [enriched] = await this.enrichWithFileDeleted([doc]);

    // Only expose shareId to the document creator (needed for E2E key resolution)
    const safeShareId = doc.creatorId === userId ? doc.shareId : null;

    return { ...enriched, teamId, shareId: safeShareId };
  }

  /**
   * Get signing page data for a recipient via their signing token.
   * No authentication required - the token IS the authentication.
   */
  async getSigningPage(signingToken: string) {
    const recipient = await this.prisma.signatureRecipient.findUnique({
      where: { signingToken },
      include: {
        document: {
          include: {
            fields: true,
            creator: { select: { username: true, email: true } },
          },
        },
      },
    });

    if (!recipient) {
      throw new NotFoundException("Invalid or expired signing link");
    }

    if (recipient.document.status === "CANCELLED") {
      throw new BadRequestException(
        "This signature request has been cancelled",
      );
    }

    // Already signed - return data with flag instead of throwing
    const alreadySigned = recipient.status === "SIGNED";

    if (
      recipient.document.expiresAt &&
      new Date() > recipient.document.expiresAt
    ) {
      throw new BadRequestException("This signature request has expired");
    }

    // Record view event (only if not already signed)
    if (!alreadySigned && recipient.status === "PENDING") {
      await this.prisma.signatureRecipient.update({
        where: { id: recipient.id },
        data: { status: "VIEWED" },
      });
      await this.createAuditEvent(
        recipient.documentId,
        "VIEWED",
        recipient.email,
      );
    }

    return {
      alreadySigned,
      documentStatus: recipient.document.status,
      document: {
        id: recipient.document.id,
        fileName: recipient.document.fileName,
        message: recipient.document.message,
        signatureLevel: recipient.document.signatureLevel,
        addApprovalField: recipient.document.addApprovalField,
        isE2EEncrypted: recipient.document.isE2EEncrypted,
        creator: recipient.document.creator,
      },
      recipient: {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        status: recipient.status,
        otpVerified: recipient.otpVerified,
      },
      fields:
        alreadySigned || !recipient.otpVerified
          ? []
          : recipient.document.fields.filter(
              (f) =>
                !f.assignedRecipientId ||
                f.assignedRecipientId === recipient.id,
            ),
      requiresOtp: !alreadySigned && !recipient.otpVerified,
    };
  }

  /**
   * Sign a document as a recipient.
   * This is the core signing action - applies the signature to the PDF.
   */
  async signDocument(
    signingToken: string,
    dto: SignDocumentDTO,
    ipAddress: string,
    userAgent: string,
  ) {
    const recipient = await this.prisma.signatureRecipient.findUnique({
      where: { signingToken },
      include: {
        document: { include: { recipients: true, fields: true } },
      },
    });

    if (!recipient) throw new NotFoundException("Invalid signing link");

    // SECURITY: Refuse if document is not PENDING
    if (recipient.document.status !== "PENDING") {
      throw new ForbiddenException(
        `Document is ${recipient.document.status.toLowerCase()}, cannot sign`,
      );
    }

    // SECURITY: Refuse if document has expired
    if (
      recipient.document.expiresAt &&
      recipient.document.expiresAt < new Date()
    ) {
      throw new ForbiddenException("This signing request has expired");
    }

    // SECURITY: Only allow signing from PENDING or VIEWED status
    if (recipient.status !== "PENDING" && recipient.status !== "VIEWED") {
      throw new ForbiddenException(
        `You have already ${recipient.status.toLowerCase()} this document`,
      );
    }

    // SECURITY: the token opens the public flow, but email OTP unlocks actions.
    if (!recipient.otpVerified) {
      throw new ForbiddenException(
        "Identity verification (OTP) required before signing",
      );
    }

    // Check signing order
    const currentOrder = Math.min(
      ...recipient.document.recipients
        .filter((r) => r.status !== "SIGNED" && r.role === "SIGNER")
        .map((r) => r.order),
    );
    if (recipient.order > currentOrder) {
      throw new BadRequestException(
        "It is not your turn to sign yet. Please wait for previous signers.",
      );
    }

    const fieldValueRows = this.collectFieldValuesForRecipient(
      recipient.id,
      recipient.document.fields,
      dto.fieldValues || [],
    );

    const signedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.signatureRecipient.updateMany({
        where: { id: recipient.id, status: { in: ["PENDING", "VIEWED"] } },
        data: {
          status: "SIGNED",
          signedAt,
          signatureData: dto.signatureData,
          signatureType: dto.signatureType,
          signingIp: ipAddress,
          signingUserAgent: userAgent,
        },
      });

      if (result.count > 0 && fieldValueRows.length > 0) {
        await tx.signatureFieldValue.createMany({
          data: fieldValueRows,
        });
      }

      return result;
    });

    if (updated.count === 0) {
      throw new ForbiddenException("Document state changed concurrently");
    }

    // Audit event
    await this.createAuditEvent(
      recipient.documentId,
      "SIGNED",
      recipient.email,
      ipAddress,
      userAgent,
      JSON.stringify({ signatureType: dto.signatureType }),
    );

    // Log team activity if the document belongs to a team
    const doc = await this.prisma.signatureDocument.findUnique({
      where: { id: recipient.documentId },
      select: { teamId: true, fileName: true },
    });
    if (doc?.teamId) {
      this.logger.log(`Logging SIGNATURE_SIGNED for team ${doc.teamId}`);
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: doc.teamId,
            action: "SIGNATURE_SIGNED",
            actorEmail: recipient.email,
            actorName: recipient.name || undefined,
            fileName: doc.fileName,
          },
        })
        .catch((err) =>
          this.logger.error(`Failed to log SIGNATURE_SIGNED: ${err.message}`),
        );
    }

    // Check if all signers have signed
    const allRecipients = await this.prisma.signatureRecipient.findMany({
      where: { documentId: recipient.documentId, role: "SIGNER" },
    });

    const allSigned = allRecipients.every((r) => r.status === "SIGNED");
    const signedCount = allRecipients.filter(
      (r) => r.status === "SIGNED",
    ).length;

    if (allSigned) {
      if (recipient.document.isE2EEncrypted) {
        // E2E: mark as awaiting client-side finalization
        await this.prisma.signatureDocument.update({
          where: { id: recipient.documentId },
          data: { status: "AWAITING_FINALIZATION" },
        });
        await this.createAuditEvent(
          recipient.documentId,
          "ALL_SIGNED",
          "system",
          undefined,
          undefined,
          "Awaiting client-side E2E finalization",
        );
        // The owner must return to the app to finalize an E2E document, so
        // make the 2/2 notification reliable after persisting the state.
        await this.notifyCreatorOfSignature(
          recipient.document,
          recipient.name,
          recipient.email,
          signedCount,
          allRecipients.length,
        );
      } else {
        // Non-E2E: finalize server-side as before
        await this.finalizeDocument(recipient.documentId);
      }
    } else {
      // Notify the owner of intermediate progress without delaying signing.
      void this.notifyCreatorOfSignature(
        recipient.document,
        recipient.name,
        recipient.email,
        signedCount,
        allRecipients.length,
      );
      // Notify next signer(s) in order
      const nextOrder = Math.min(
        ...allRecipients
          .filter((r) => r.status !== "SIGNED")
          .map((r) => r.order),
      );
      const nextSigners = allRecipients.filter(
        (r) => r.order === nextOrder && r.status !== "SIGNED",
      );

      const doc = await this.prisma.signatureDocument.findUnique({
        where: { id: recipient.documentId },
      });

      for (const next of nextSigners) {
        await this.sendSigningInvitation(doc!, next);
      }
    }

    return { status: "SIGNED", allSigned };
  }

  /**
   * Notify the document creator that a specific signer has signed.
   */
  private async notifyCreatorOfSignature(
    document: { id: string; creatorId: string; fileName: string },
    signerName: string,
    signerEmail: string,
    signedCount: number,
    totalSigners: number,
  ) {
    try {
      const creator = await this.prisma.user.findUnique({
        where: { id: document.creatorId },
      });
      if (!creator?.email) return;
      const baseUrl = await this.configService.get("general.appUrl");
      await this.emailService.sendMail(
        creator.email,
        `Signature reçue (${signedCount}/${totalSigners}) - ${document.fileName}`,
        `Bonjour ${creator.username || ""},\n\n` +
          `${signerName} (${signerEmail}) a signé le document "${document.fileName}".\n\n` +
          `Progression : ${signedCount}/${totalSigners} signataires.\n\n` +
          `Suivez l'avancement ici :\n${baseUrl}/signing/${document.id}\n\n` +
          `-- \nPrivCloud Sharing - Signature Électronique`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to notify signature creator for ${document.id}: ${error?.message || error}`,
      );
    }
  }

  /**
   * Reject a document as a recipient.
   */
  async rejectDocument(
    signingToken: string,
    reason: string | undefined,
    ipAddress: string,
    userAgent: string,
  ) {
    const recipient = await this.prisma.signatureRecipient.findUnique({
      where: { signingToken },
      include: { document: { include: { creator: true } } },
    });

    if (!recipient) throw new NotFoundException("Invalid signing link");

    // SECURITY: Refuse action if document is not PENDING
    if (recipient.document.status !== "PENDING") {
      throw new ForbiddenException(
        "This document is no longer pending and cannot be rejected",
      );
    }

    // SECURITY: Refuse action if document has expired
    if (
      recipient.document.expiresAt &&
      recipient.document.expiresAt < new Date()
    ) {
      throw new ForbiddenException("This signing request has expired");
    }

    // SECURITY: the token opens the public flow, but email OTP unlocks actions.
    if (!recipient.otpVerified) {
      throw new ForbiddenException(
        "Identity verification (OTP) required before rejecting",
      );
    }

    // SECURITY: Refuse action if recipient already finalized (signed/rejected)
    if (recipient.status !== "PENDING" && recipient.status !== "VIEWED") {
      throw new ForbiddenException(
        `You have already ${recipient.status.toLowerCase()} this document`,
      );
    }

    // Use conditional update to prevent race conditions
    const updated = await this.prisma.signatureRecipient.updateMany({
      where: { id: recipient.id, status: { in: ["PENDING", "VIEWED"] } },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        signingIp: ipAddress,
        signingUserAgent: userAgent,
      },
    });

    if (updated.count === 0) {
      throw new ForbiddenException("Document state changed concurrently");
    }

    // Mark document as cancelled if a required signer rejects
    if (recipient.role === "SIGNER") {
      await this.prisma.signatureDocument.updateMany({
        where: { id: recipient.documentId, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
    }

    await this.createAuditEvent(
      recipient.documentId,
      "REJECTED",
      recipient.email,
      ipAddress,
      userAgent,
      reason ? JSON.stringify({ reason }) : undefined,
    );

    // Notify document creator
    if (recipient.document.creator) {
      await this.emailService.sendMail(
        recipient.document.creator.email,
        `Signature refusée - ${recipient.document.fileName}`,
        `${recipient.name} (${recipient.email}) a refusé de signer le document "${recipient.document.fileName}".\n\n` +
          (reason ? `Raison : ${reason}\n\n` : "") +
          `La demande de signature a été annulée.`,
      );
    }

    // Log team activity
    if (recipient.document.teamId) {
      this.logger.log(
        `Logging SIGNATURE_REJECTED for team ${recipient.document.teamId}`,
      );
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: recipient.document.teamId,
            action: "SIGNATURE_REJECTED",
            actorEmail: recipient.email,
            actorName: recipient.name || undefined,
            fileName: recipient.document.fileName,
          },
        })
        .catch((err) =>
          this.logger.error(`Failed to log SIGNATURE_REJECTED: ${err.message}`),
        );
    }

    return { status: "REJECTED" };
  }

  /**
   * Cancel a signature request (by the document creator).
   */
  async cancelDocument(documentId: string, userId: string) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId },
      include: { recipients: true },
    });

    if (!doc) throw new NotFoundException("Document not found");
    if (doc.status === "COMPLETED") {
      throw new BadRequestException("Cannot cancel a completed document");
    }

    await this.prisma.signatureDocument.update({
      where: { id: documentId },
      data: { status: "CANCELLED" },
    });

    await this.createAuditEvent(documentId, "CANCELLED", "system");

    // Log team activity
    if (doc.teamId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      this.logger.log(`Logging SIGNATURE_CANCEL for team ${doc.teamId}`);
      this.prisma.teamAccessLog
        .create({
          data: {
            teamId: doc.teamId,
            action: "SIGNATURE_CANCEL",
            actorEmail: user?.email || "unknown",
            actorName: user?.username || undefined,
            fileName: doc.fileName,
          },
        })
        .catch((err) =>
          this.logger.error(`Failed to log SIGNATURE_CANCEL: ${err.message}`),
        );
    }

    // Notify pending recipients
    for (const r of doc.recipients.filter(
      (r) => r.status === "PENDING" || r.status === "VIEWED",
    )) {
      await this.emailService.sendMail(
        r.email,
        `Signature annulée - ${doc.fileName}`,
        `La demande de signature pour le document "${doc.fileName}" a été annulée par l'expéditeur.`,
      );
    }

    return { status: "CANCELLED" };
  }

  /**
   * Send a reminder to pending recipients.
   */
  async sendReminder(documentId: string, userId: string) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: { id: documentId, creatorId: userId, status: "PENDING" },
      include: { recipients: true },
    });

    if (!doc) throw new NotFoundException("Document not found or not pending");

    const pendingRecipients = doc.recipients.filter(
      (r) => r.status === "PENDING" || r.status === "VIEWED",
    );

    let remindersSent = 0;
    let emailDeliveryFailures = 0;
    for (const recipient of pendingRecipients) {
      const sent = await this.sendSigningInvitation(doc, recipient, true);
      if (sent) remindersSent++;
      else emailDeliveryFailures++;
    }

    await this.createAuditEvent(documentId, "REMINDER_SENT", userId);

    return { remindersSent, emailDeliveryFailures };
  }

  /**
   * Retry server-side finalization for a non-E2E document.
   * Only the creator can trigger this; document must be in AWAITING_FINALIZATION.
   */
  async retryFinalize(documentId: string, userId: string) {
    const doc = await this.prisma.signatureDocument.findFirst({
      where: {
        id: documentId,
        creatorId: userId,
        status: "AWAITING_FINALIZATION",
        isE2EEncrypted: false,
      },
    });

    if (!doc) {
      throw new NotFoundException(
        "Document not found or not eligible for retry",
      );
    }

    await this.finalizeDocument(documentId);

    // Check if finalization succeeded
    const updated = await this.prisma.signatureDocument.findUnique({
      where: { id: documentId },
      select: { status: true },
    });

    return { status: updated?.status || "AWAITING_FINALIZATION" };
  }

  private validateSignatureFields(dto: CreateSignatureRequestDTO) {
    if (!dto.fields?.length) return;
    const recipientEmails = new Set(
      dto.recipients.map((recipient) => recipient.email.toLowerCase()),
    );

    for (const field of dto.fields) {
      if (
        field.assignedRecipientEmail &&
        !recipientEmails.has(field.assignedRecipientEmail.toLowerCase())
      ) {
        throw new BadRequestException(
          "Signature field is assigned to an unknown recipient",
        );
      }
      if (field.type === "APPROVAL" && !field.label?.trim()) {
        throw new BadRequestException(
          "Approval fields require the exact text the signer must type",
        );
      }
    }
  }

  private collectFieldValuesForRecipient(
    recipientId: string,
    fields: Array<{
      id: string;
      type: string;
      label: string | null;
      required: boolean;
      assignedRecipientId: string | null;
    }>,
    submittedValues: Array<{ fieldId: string; value: string }>,
  ) {
    const fillableFields = fields.filter(
      (field) =>
        !field.assignedRecipientId || field.assignedRecipientId === recipientId,
    );
    const fillableFieldIds = new Set(fillableFields.map((field) => field.id));
    const submittedByField = new Map(
      submittedValues.map((entry) => [entry.fieldId, entry.value.trim()]),
    );

    for (const submitted of submittedValues) {
      if (!fillableFieldIds.has(submitted.fieldId)) {
        throw new ForbiddenException(
          "Cannot fill a field assigned to another signer",
        );
      }
    }

    const rows: Array<{ fieldId: string; recipientId: string; value: string }> =
      [];
    for (const field of fillableFields) {
      if (field.type === "SIGNATURE" || field.type === "INITIALS") continue;

      let value = submittedByField.get(field.id) || "";
      if (field.type === "DATE" && !value) {
        value = new Date().toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Europe/Paris",
        });
      }

      if (field.required && !value) {
        throw new BadRequestException("A required signature field is missing");
      }

      if (
        field.type === "APPROVAL" &&
        field.label?.trim() &&
        this.normalizeSignatureText(value) !==
          this.normalizeSignatureText(field.label)
      ) {
        throw new BadRequestException(
          "The approval mention does not match the expected text",
        );
      }

      if (value) rows.push({ fieldId: field.id, recipientId, value });
    }

    return rows;
  }

  private normalizeSignatureText(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Finalize a document after all signatures are collected.
   * - Apply all signatures to the PDF
   * - Add "Bon pour Accord" watermark
   * - Append certificate page
   * - Cryptographically sign the final PDF
   */
  private async finalizeDocument(documentId: string) {
    const doc = await this.prisma.signatureDocument.findUnique({
      where: { id: documentId },
      include: {
        recipients: { where: { role: "SIGNER" } },
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

    if (!doc) return;

    this.logger.log(`Finalizing document ${documentId}`);

    try {
      // Load original PDF
      let pdfBuffer = await this.fileService.getFileByKey(doc.originalFileKey);

      const filledTextFields = doc.fields.filter(
        (field) =>
          !["SIGNATURE", "INITIALS"].includes(field.type) &&
          field.fieldValues.length > 0,
      );
      if (filledTextFields.length > 0) {
        pdfBuffer = await this.pdfSigningService.addSignatureFieldValues(
          pdfBuffer,
          filledTextFields,
        );
      }

      // Apply each signer's signature to the PDF after text fields so it stays visible.
      for (const recipient of doc.recipients) {
        const signatureImage = recipient.signatureData
          ? Buffer.from(
              recipient.signatureData.replace(/^data:image\/\w+;base64,/, ""),
              "base64",
            )
          : undefined;
        const signatureField =
          doc.fields.find(
            (field) =>
              field.type === "SIGNATURE" &&
              field.assignedRecipientId === recipient.id,
          ) ||
          doc.fields.find(
            (field) => field.type === "SIGNATURE" && !field.assignedRecipientId,
          );

        pdfBuffer = await this.pdfSigningService.addApprovalFieldAndSignature(
          pdfBuffer,
          {
            name: recipient.name,
            signatureImage:
              recipient.signatureType === "DRAW" ||
              recipient.signatureType === "UPLOAD"
                ? signatureImage
                : undefined,
            signatureText:
              recipient.signatureType === "TYPE"
                ? recipient.signatureData
                : undefined,
            signedDate: recipient.signedAt!,
          },
          {
            addApprovalWatermark: doc.addApprovalField,
            addApprovalMention: doc.addApprovalMention,
            signaturePage: doc.signaturePage ?? undefined,
            watermarkPage: doc.watermarkPage ?? undefined,
            signatureField: signatureField
              ? {
                  page: signatureField.page,
                  posX: signatureField.posX,
                  posY: signatureField.posY,
                  width: signatureField.width,
                  height: signatureField.height,
                }
              : undefined,
          },
        );
      }

      // Add initials at bottom of each page if enabled
      if (doc.addInitials && doc.recipients.length > 0) {
        pdfBuffer = await this.pdfSigningService.addInitialsToAllPages(
          pdfBuffer,
          doc.recipients.map((r) => r.name),
        );
      }

      // Generate certificate page
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

      // Merge certificate page into the document
      const { PDFDocument } = await import("pdf-lib");
      const mainDoc = await PDFDocument.load(pdfBuffer);
      const certDoc = await PDFDocument.load(certPage);
      const [certPageCopy] = await mainDoc.copyPages(certDoc, [0]);
      mainDoc.addPage(certPageCopy);
      pdfBuffer = Buffer.from(await mainDoc.save());

      // Apply cryptographic signature (PAdES)
      const appUrl = this.configService.get("general.appUrl") as string;
      const signingDomain = new URL(appUrl).hostname;
      try {
        pdfBuffer = await this.pdfSigningService.signPdf(pdfBuffer, {
          name: "PrivCloud Sharing",
          email: `signing@${signingDomain}`,
          reason:
            "Signature électronique eIDAS - Tous les signataires ont signé",
        });
      } catch (signingError: any) {
        // SECURITY: Fail-closed - mark document as SIGNING_FAILED, do NOT mark COMPLETED
        this.logger.error(
          `Signing failed for document ${documentId}: ${signingError?.message}`,
        );
        await this.prisma.signatureDocument.update({
          where: { id: documentId },
          data: { status: "SIGNING_FAILED" },
        });
        await this.createAuditEvent(documentId, "SIGNING_FAILED", "system");
        throw signingError;
      }

      // Store the signed PDF
      const signedKey = `signed/${documentId}/${doc.fileName}`;
      await this.fileService.storeFileByKey(signedKey, pdfBuffer);

      // Update document status
      await this.prisma.signatureDocument.update({
        where: { id: documentId },
        data: { status: "COMPLETED", signedFileKey: signedKey },
      });

      await this.createAuditEvent(documentId, "COMPLETED", "system");

      // Log team activity if this is a team document
      if (doc.teamId) {
        this.logger.log(`Logging SIGNATURE_COMPLETE for team ${doc.teamId}`);
        this.prisma.teamAccessLog
          .create({
            data: {
              teamId: doc.teamId,
              action: "SIGNATURE_COMPLETE",
              actorEmail: "system",
              actorName: "Signature automatique",
              fileName: doc.fileName,
            },
          })
          .catch((err) =>
            this.logger.error(
              `Failed to log SIGNATURE_COMPLETE: ${err.message}`,
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
              `Completion email failed for ${documentId} to ${email}: ${error?.message || error}`,
            ),
        });
      } catch (notificationError: any) {
        this.logger.error(
          `Failed to prepare completion emails for ${documentId}: ${notificationError?.message || notificationError}`,
        );
      }

      this.logger.log(`Document ${documentId} finalized successfully`);
    } catch (error: any) {
      this.logger.error(
        `Failed to finalize document ${documentId}: ${error?.message}`,
      );

      // SECURITY: Fail-closed - only overwrite status if it's NOT already
      // SIGNING_FAILED (set by the inner PAdES catch). A crypto failure
      // must stay marked as such and never be softened.
      const currentDoc = await this.prisma.signatureDocument
        .findUnique({
          where: { id: documentId },
          select: { status: true },
        })
        .catch(() => null);

      if (currentDoc?.status !== "SIGNING_FAILED") {
        await this.prisma.signatureDocument
          .update({
            where: { id: documentId },
            data: { status: "AWAITING_FINALIZATION" },
          })
          .catch(() => {});
      }

      await this.createAuditEvent(
        documentId,
        "FINALIZATION_FAILED",
        "system",
        undefined,
        undefined,
        `Server-side finalization failed: ${error?.message || "Unknown error"}`,
      ).catch(() => {});

      // Notify creator of the failure
      if (doc?.creatorId) {
        const creator = await this.prisma.user
          .findUnique({
            where: { id: doc.creatorId },
          })
          .catch(() => null);
        if (creator?.email) {
          const baseUrl = await this.configService
            .get("general.appUrl")
            .catch(() => "");
          await this.emailService
            .sendMail(
              creator.email,
              `Erreur de finalisation - ${doc.fileName}`,
              `Bonjour ${creator.username || ""},\n\n` +
                `La finalisation automatique du document "${doc.fileName}" a échoué.\n` +
                `Toutes les signatures ont été collectées mais le document n'a pas pu être finalisé.\n\n` +
                `Vous pouvez réessayer en vous rendant sur :\n${baseUrl}/signing/${documentId}\n\n` +
                `Si le problème persiste, contactez le support.\n\n` +
                `-- \nPrivCloud Sharing - Signature Électronique`,
            )
            .catch(() => {});
        }
      }
    }
  }

  /**
   * Send a signing invitation email to a recipient.
   */
  private async sendSigningInvitation(
    document: any,
    recipient: any,
    isReminder = false,
  ): Promise<boolean> {
    const baseUrl = await this.configService.get("general.appUrl");
    const signingUrl = `${baseUrl}/sign/${recipient.signingToken}`;

    const subject = isReminder
      ? `Rappel : Signature requise - ${document.fileName}`
      : `Signature requise - ${document.fileName}`;

    const body =
      `Bonjour ${recipient.name},\n\n` +
      (isReminder ? "Ceci est un rappel. " : "") +
      `Vous avez reçu une demande de signature électronique pour le document "${document.fileName}".\n\n` +
      (document.message
        ? `Message de l'expéditeur :\n${document.message}\n\n`
        : "") +
      `Pour signer ce document, cliquez sur le lien ci-dessous :\n${signingUrl}\n\n` +
      `Ce lien est personnel et sécurisé. Ne le partagez pas.\n\n` +
      `Niveau de signature : ${document.signatureLevel === "QES" ? "Qualifiée (QES)" : "Avancée (AES)"}\n\n` +
      `-- \nPrivCloud Sharing - Signature Électronique`;

    try {
      await this.emailService.sendMail(recipient.email, subject, body);

      await this.createAuditEvent(
        document.id,
        isReminder ? "REMINDER_SENT" : "SENT",
        recipient.email,
      );

      return true;
    } catch (error) {
      this.logger.warn(
        `Signing invitation email failed for ${recipient.email}: ${this.getErrorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Send a CC notification to a carbon-copy recipient.
   */
  private async sendCcNotification(
    document: any,
    recipient: any,
    creator: User,
  ): Promise<boolean> {
    const body =
      `Bonjour ${recipient.name},\n\n` +
      `${creator.username} (${creator.email}) a envoyé une demande de signature électronique ` +
      `pour le document "${document.fileName}".\n\n` +
      `Vous êtes en copie de cette demande. Vous serez notifié(e) lorsque tous les signataires auront signé.\n\n` +
      `-- \nPrivCloud Sharing - Signature Électronique`;

    try {
      await this.emailService.sendMail(
        recipient.email,
        `Copie : Demande de signature - ${document.fileName}`,
        body,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Signing CC email failed for ${recipient.email}: ${this.getErrorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Send the E2E key in a separate email when the sender explicitly opts in.
   */
  private async sendE2EKeyEmail(
    document: any,
    recipient: any,
    e2eKey: string,
  ): Promise<boolean> {
    const subject = `Clé de déchiffrement E2E - ${document.fileName}`;
    const keyFragment = `#key=${e2eKey}`;
    const body =
      `Bonjour ${recipient.name},\n\n` +
      `Vous recevez cet email séparé car l'expéditeur a choisi de vous transmettre ` +
      `la clé de déchiffrement du document "${document.fileName}" par email.\n\n` +
      `Le lien personnel de signature reste dans l'email principal. Pour ouvrir le document, ` +
      `ajoutez le fragment ci-dessous à la fin de ce lien :\n${keyFragment}\n\n` +
      `Si votre invitation principale n'est pas encore arrivée, conservez cet email : ` +
      `elle peut être envoyée plus tard selon l'ordre de signature.\n\n` +
      `Ne transférez pas cette clé et ne la publiez pas.\n\n` +
      `-- \nPrivCloud Sharing - Signature Électronique`;

    try {
      await this.emailService.sendMail(recipient.email, subject, body);
      return true;
    } catch (error) {
      this.logger.warn(
        `Signing E2E key email failed for ${recipient.email}: ${this.getErrorMessage(error)}`,
      );
      return false;
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /**
   * Enriches signature documents with a `fileDeleted` boolean.
   * A file is considered deleted when:
   *   - the source share no longer exists in DB (expired / manually removed), OR
   *   - the individual file was deleted from the share while the share still exists.
   */
  private async enrichWithFileDeleted<
    T extends { shareId: string | null; fileId?: string | null },
  >(docs: T[]): Promise<(T & { fileDeleted: boolean })[]> {
    if (docs.length === 0) return [];

    const shareIds = [
      ...new Set(docs.map((d) => d.shareId).filter(Boolean) as string[]),
    ];
    const fileIds = [
      ...new Set(
        docs
          .map((d) => (d as { fileId?: string | null }).fileId)
          .filter(Boolean) as string[],
      ),
    ];

    const [existingShares, existingFiles] = await Promise.all([
      shareIds.length > 0
        ? this.prisma.share.findMany({
            where: { id: { in: shareIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
      fileIds.length > 0
        ? this.prisma.file.findMany({
            where: { id: { in: fileIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    const existingShareIds = new Set(existingShares.map((s) => s.id));
    const existingFileIds = new Set(existingFiles.map((f) => f.id));

    const results: (T & { fileDeleted: boolean })[] = [];
    const idsToMarkDeleted: string[] = [];

    for (const doc of docs) {
      const docFileId = (doc as { fileId?: string | null }).fileId;
      const shareGone =
        doc.shareId == null || !existingShareIds.has(doc.shareId);
      const fileGone = docFileId != null && !existingFileIds.has(docFileId);
      const fileDeleted = shareGone || fileGone;

      results.push({ ...doc, fileDeleted });

      // Persist fileDeletedAt on first detection
      if (fileDeleted && !(doc as any).fileDeletedAt) {
        idsToMarkDeleted.push((doc as any).id);
      }
    }

    if (idsToMarkDeleted.length > 0) {
      await this.prisma.signatureDocument.updateMany({
        where: { id: { in: idsToMarkDeleted }, fileDeletedAt: null },
        data: { fileDeletedAt: new Date() },
      });
    }

    return results;
  }

  /**
   * Create an immutable audit trail event.
   */
  private async createAuditEvent(
    documentId: string,
    eventType: string,
    actor: string,
    ipAddress?: string,
    userAgent?: string,
    metadata?: string,
  ) {
    await this.prisma.signatureAuditEvent.create({
      data: {
        documentId,
        eventType,
        actor,
        ipAddress,
        userAgent,
        metadata,
      },
    });
  }
}
