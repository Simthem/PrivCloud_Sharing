/**
 * What the document APIs may return about recipients and audit events. The
 * forensic data (network data, account identifiers, raw WebAuthn material,
 * OTP state) never leaves through them, and a signing link, which is the only
 * secret of a public recipient, is only returned to the requester.
 */

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
  createdAt: Date;
};

export function toVisibleRecipient(
  recipient: RecipientRow,
  viewer: { userId: string; email?: string | null; isRequester: boolean },
) {
  const isCurrentUser =
    (recipient.userId !== null && recipient.userId === viewer.userId) ||
    (!!viewer.email &&
      recipient.email.toLowerCase() === viewer.email.toLowerCase());
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
    // Only its owner can unwrap it, and only its owner receives it.
    ...(isCurrentUser && recipient.wrappedE2EKey
      ? { wrappedE2EKey: recipient.wrappedE2EKey }
      : {}),
    ...(viewer.isRequester ? { signingToken: recipient.signingToken } : {}),
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
