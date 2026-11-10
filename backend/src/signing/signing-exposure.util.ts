import { openToken } from "../config/account-secrets";

/** Recipient records expose signing links only to the requester. A separate
 * account action exposes only the current signer's active invitation. */

type RecipientRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  order: number;
  status: string;
  signedAt: Date | null;
  rejectionReason: string | null;
  signatureType: string | null;
  authenticationMethod: string | null;
  identityVerificationMethod: string | null;
  identityVerifiedAt: Date | null;
  webauthnUserVerified: boolean | null;
  signedDocumentHash: string | null;
  signingIntentHash: string | null;
  evidenceId: string | null;
  forensicRecordSha256: string | null;
  signingToken: string;
  userId: string | null;
  wrappedE2EKey?: string | null;
  encryptedKeyEnvelope?: string | null;
  keyEnvelopeUserId?: string | null;
  createdAt: Date;
};

export type SigningViewer = {
  userId: string;
  email?: string | null;
  isRequester: boolean;
};

export function isRecipientViewer(
  recipient: Pick<RecipientRow, "userId" | "email">,
  viewer: SigningViewer,
) {
  return recipient.userId
    ? recipient.userId === viewer.userId
    : !!viewer.email &&
        recipient.email.toLowerCase() === viewer.email.toLowerCase();
}

export function toSigningAction(
  document: {
    id: string;
    isE2EEncrypted?: boolean;
    status: string;
    fileId?: string | null;
    fileDeletedAt?: Date | null;
    expiresAt?: Date | null;
    recipients: Pick<
      RecipientRow,
      | "id"
      | "userId"
      | "email"
      | "role"
      | "status"
      | "order"
      | "signingToken"
      | "wrappedE2EKey"
      | "encryptedKeyEnvelope"
      | "keyEnvelopeUserId"
    >[];
  },
  viewer: SigningViewer,
) {
  if (
    !["PENDING", "PARTIAL"].includes(document.status) ||
    document.fileId === null ||
    document.fileDeletedAt ||
    (document.expiresAt && document.expiresAt.getTime() <= Date.now())
  )
    return null;

  const nextOrder = Math.min(
    ...document.recipients
      .filter(
        (recipient) =>
          recipient.role === "SIGNER" && recipient.status !== "SIGNED",
      )
      .map((recipient) => recipient.order),
  );
  const recipient = document.recipients.find(
    (recipient) =>
      isRecipientViewer(recipient, viewer) &&
      recipient.role === "SIGNER" &&
      ["PENDING", "VIEWED"].includes(recipient.status) &&
      recipient.order <= nextOrder,
  );
  if (!recipient) return null;
  return {
    recipientId: recipient.id,
    ...(document.isE2EEncrypted ? { isE2EEncrypted: true } : {}),
    ...(document.isE2EEncrypted &&
    document.fileId &&
    recipient.encryptedKeyEnvelope &&
    recipient.keyEnvelopeUserId === viewer.userId
      ? {
          keyEnvelope: {
            ciphertext: recipient.encryptedKeyEnvelope,
            documentId: document.id,
            fileId: document.fileId,
            recipientUserId: viewer.userId,
          },
        }
      : {}),
    path: `/sign/${openToken("signing", recipient.signingToken)}`,
    ...(recipient.wrappedE2EKey
      ? { wrappedE2EKey: recipient.wrappedE2EKey }
      : {}),
  };
}

export function toVisibleRecipient(
  recipient: RecipientRow,
  viewer: { userId: string; email?: string | null; isRequester: boolean },
) {
  const isCurrentUser = isRecipientViewer(recipient, viewer);
  return {
    id: recipient.id,
    name: recipient.name,
    email: recipient.email,
    role: recipient.role,
    order: recipient.order,
    status: recipient.status,
    signedAt: recipient.signedAt,
    rejectionReason: recipient.rejectionReason,
    signatureType: recipient.signatureType,
    authenticationMethod: recipient.authenticationMethod,
    identityVerificationMethod: recipient.identityVerificationMethod,
    identityVerifiedAt: recipient.identityVerifiedAt,
    webauthnUserVerified: recipient.webauthnUserVerified,
    signedDocumentHash: recipient.signedDocumentHash,
    signingIntentHash: recipient.signingIntentHash,
    evidenceId: recipient.evidenceId,
    forensicRecordSha256: recipient.forensicRecordSha256,
    createdAt: recipient.createdAt,
    isCurrentUser,
    hasKeyEnvelope: Boolean(recipient.encryptedKeyEnvelope),
    ...(isCurrentUser &&
    recipient.encryptedKeyEnvelope &&
    recipient.keyEnvelopeUserId === viewer.userId
      ? { encryptedKeyEnvelope: recipient.encryptedKeyEnvelope }
      : {}),
    // Only its owner can unwrap it, and only its owner receives it.
    ...(isCurrentUser && recipient.wrappedE2EKey
      ? { wrappedE2EKey: recipient.wrappedE2EKey }
      : {}),
    ...(viewer.isRequester
      ? { signingToken: openToken("signing", recipient.signingToken) }
      : {}),
  };
}

export function toVisibleAuditEvent(event: {
  id: string;
  eventType: string;
  actor: string;
  metadata: string | null;
  createdAt: Date;
  previousEventHash: string | null;
  eventHash: string | null;
}) {
  return {
    id: event.id,
    eventType: event.eventType,
    actor: event.actor,
    metadata: event.metadata,
    createdAt: event.createdAt,
    previousEventHash: event.previousEventHash,
    eventHash: event.eventHash,
  };
}
