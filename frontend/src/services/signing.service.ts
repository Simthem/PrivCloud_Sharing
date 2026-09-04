import api from "./api.service";
import { apiPathSegment } from "../utils/apiPath.util";
import { selectPqNotificationPublicKey } from "../utils/pqNotification.util";
import { buildSigningNotificationActions } from "../utils/signingNotification.util";
import teamService from "./team.service";
import {
  batchGetPublicKeys,
  encryptNotificationMetadata,
} from "./crypto.service";

export interface SignatureRequest {
  id: string;
  title?: string;
  fileName: string;
  message?: string;
  status: string;
  signatureLevel: string;
  isE2EEncrypted?: boolean;
  teamId?: string;
  recipients: SignatureRecipient[];
  createdAt: string;
  completedAt?: string;
  fileDeleted?: boolean;
  fileDeletedAt?: string;
  creator?: { id: string; username?: string; email: string };
}

export interface SignatureRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  order?: number;
  signedAt?: string;
  signingToken?: string;
  identityVerificationMethod?: string;
  identityVerifiedAt?: string;
  authenticationMethod?: string;
  signingIntentHash?: string;
  signedDocumentHash?: string;
}

export interface SigningPageData {
  documentStatus: string;
  document: {
    id: string;
    fileName: string;
    message?: string;
    signatureLevel: string;
    addApprovalField?: boolean;
    isE2EEncrypted?: boolean;
    creator?: { username: string; email: string };
  };
  recipient: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    emailVerified: boolean;
    identityVerificationMethod: string;
    identityVerifiedAt?: string;
  };
  fields: {
    id: string;
    type: string;
    page: number;
    posX: number;
    posY: number;
    width: number;
    height: number;
    label?: string | null;
    required: boolean;
  }[];
  requiresPasskey: boolean;
  requiresEmailVerification: boolean;
  emailVerificationCodePending: boolean;
  hasRegisteredPasskey: boolean;
}

export interface CreateSignatureRequestPayload {
  id?: string;
  notificationCreatorId?: string;
  /** Client-only key embedded inside recipient-encrypted notification actions. */
  notificationE2EKey?: string;
  shareId: string;
  fileId: string;
  message?: string;
  signatureLevel?: "STANDARD" | "REINFORCED";
  expiresAt?: string;
  addApprovalField?: boolean;
  addApprovalMention?: boolean;
  addInitials?: boolean;
  initialsPlacement?: "BOTTOM_LEFT" | "BOTTOM_CENTER_RIGHT" | "BOTTOM_RIGHT";
  initialsIncludeSignaturePage?: boolean;
  signaturePage?: number;
  watermarkPage?: number;
  isE2EEncrypted?: boolean;
  sendE2EKeyByEmail?: boolean;
  e2eKey?: string;
  recipients: {
    name: string;
    email: string;
    role?: "SIGNER" | "APPROVER" | "CC";
    order?: number;
    signingToken?: string;
    teamInviteNotification?: string;
    teamProgressNotification?: string;
    teamCompletionNotification?: string;
  }[];
  fields?: {
    assignedRecipientEmail?: string;
    type: "SIGNATURE" | "INITIALS" | "DATE" | "TEXT" | "APPROVAL";
    page: number;
    posX: number;
    posY: number;
    width: number;
    height: number;
    required?: boolean;
    label?: string;
  }[];
  teamId?: string;
}

// ============================================================
// Authenticated (document owner) endpoints
// ============================================================

const createRequest = async (
  data: CreateSignatureRequestPayload,
): Promise<SignatureRequest> => {
  const { notificationCreatorId, notificationE2EKey, ...request } = data;
  const prepared = await prepareTeamSigningNotifications(
    request,
    notificationCreatorId,
    notificationE2EKey,
  );
  return (await api.post("signing/request", prepared)).data;
};

/** Build recipient-specific PQ-hybrid notification actions in the browser. */
const prepareTeamSigningNotifications = async (
  request: Omit<CreateSignatureRequestPayload, "notificationCreatorId">,
  creatorUserId?: string,
  notificationE2EKey?: string,
): Promise<Omit<CreateSignatureRequestPayload, "notificationCreatorId">> => {
  if (!request.teamId || !creatorUserId || !globalThis.crypto?.randomUUID)
    return request;

  const documentId = crypto.randomUUID();
  const team = await teamService.getTeam(request.teamId);
  const members = (team.members || []).filter(
    (member) => member.isActive && member.user,
  );
  const memberByEmail = new Map(
    members.map((member) => [member.user!.email.trim().toLowerCase(), member]),
  );
  const keys = await batchGetPublicKeys([
    ...new Set([creatorUserId, ...members.map((member) => member.userId)]),
  ]);
  const keyByUserId = new Map(keys.map((key) => [key.userId, key]));
  const creatorKey = keyByUserId.get(creatorUserId);

  const recipients = await Promise.all(
    request.recipients.map(async (recipient) => {
      const signingToken = crypto.randomUUID();
      const actions = buildSigningNotificationActions(
        signingToken,
        request.isE2EEncrypted ? notificationE2EKey : null,
      );
      const member = memberByEmail.get(recipient.email.trim().toLowerCase());
      const recipientKey = member ? keyByUserId.get(member.userId) : undefined;
      const encryptFor = async (
        key: typeof recipientKey,
        actionUrl: string,
        action: string,
      ) => {
        // ML-KEM is an explicit Team policy. Members without a registered PQ key
        // retain the existing X25519 E2E path instead of losing notifications.
        if (!key?.x25519) return undefined;
        return encryptNotificationMetadata(
          { actionUrl, action, fileName: "Document de signature" },
          key.x25519.publicKey,
          selectPqNotificationPublicKey(
            Boolean(team.pqNotificationEncryptionEnabled),
            key.pqKey?.publicKey,
          ),
        );
      };
      return {
        ...recipient,
        signingToken,
        teamInviteNotification: await encryptFor(
          recipientKey,
          actions.invitation,
          "SIGN",
        ),
        teamProgressNotification: await encryptFor(
          creatorKey,
          `/signing/${documentId}`,
          "TRACK",
        ),
        teamCompletionNotification: await encryptFor(
          recipientKey,
          actions.completion,
          "DOWNLOAD",
        ),
      };
    }),
  );
  return { ...request, id: documentId, recipients };
};

const getMyDocuments = async (): Promise<SignatureRequest[]> => {
  return (await api.get("signing/documents")).data;
};

const getReceivedDocuments = async (): Promise<SignatureRequest[]> => {
  return (await api.get("signing/received")).data;
};

const getDocument = async (id: string): Promise<SignatureRequest> => {
  return (await api.get(`signing/documents/${apiPathSegment(id)}`)).data;
};

const cancelDocument = async (id: string): Promise<void> => {
  await api.delete(`signing/documents/${apiPathSegment(id)}`);
};

const sendReminder = async (id: string): Promise<void> => {
  await api.post(`signing/documents/${apiPathSegment(id)}/remind`);
};

const downloadSigned = async (id: string): Promise<Blob> => {
  const response = await api.get(
    `signing/documents/${apiPathSegment(id)}/download`,
    {
      responseType: "blob",
    },
  );
  return response.data;
};

const getAuditTrail = async (id: string): Promise<any> => {
  return (await api.get(`signing/documents/${apiPathSegment(id)}/audit`)).data;
};

const getSignaturesForFinalization = async (id: string): Promise<any> => {
  return (await api.get(`signing/documents/${apiPathSegment(id)}/signatures`))
    .data;
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Request only the server-generated audit certificate page. */
const getE2ECertificatePage = async (
  id: string,
  documentHash: string,
): Promise<Uint8Array> => {
  const res = (
    await api.post(
      `signing/documents/${apiPathSegment(id)}/e2e-certificate-page`,
      {
        documentHash,
      },
    )
  ).data;
  return decodeBase64(res.certificatePage);
};

/** Send only the PDF ByteRange SHA-256 digest and receive its detached CMS. */
const signE2EDigest = async (
  id: string,
  digest: string,
): Promise<Uint8Array> => {
  const res = (
    await api.post(`signing/documents/${apiPathSegment(id)}/sign-e2e-digest`, {
      digest,
    })
  ).data;
  return decodeBase64(res.cms);
};

/**
 * E2E Step 2: Send re-encrypted signed PDF for storage.
 * Backend stores it and marks the document COMPLETED.
 */
const finalizeE2E = async (
  id: string,
  encryptedPdfBuffer: ArrayBuffer,
): Promise<any> => {
  const bytes = new Uint8Array(encryptedPdfBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return (
    await api.post(`signing/documents/${apiPathSegment(id)}/finalize-e2e`, {
      encryptedPdf: base64,
    })
  ).data;
};

// ============================================================
// Public (recipient token) endpoints
// ============================================================

const getSigningPage = async (token: string): Promise<SigningPageData> => {
  return (await api.get(`signing/sign/${apiPathSegment(token)}`)).data;
};

const sendSigningEmailOtp = async (token: string) =>
  (await api.post(`signing/sign/${apiPathSegment(token)}/email-otp/send`))
    .data as {
    verified: boolean;
    sent: boolean;
    expiresInSeconds?: number;
  };

const verifySigningEmailOtp = async (token: string, code: string) =>
  (
    await api.post(`signing/sign/${apiPathSegment(token)}/email-otp/verify`, {
      code,
    })
  ).data as { verified: boolean };

type PasskeyActionPayload =
  | {
      action: "SIGN";
      signatureData: string;
      signatureType: string;
      fieldValues?: { fieldId: string; value: string }[];
    }
  | { action: "REJECT"; reason?: string };

const beginPasskeyRegistration = async (token: string) =>
  (
    await api.post(
      `signing/sign/${apiPathSegment(token)}/passkey/register/options`,
    )
  ).data as { challengeId: string; options: Record<string, unknown> };

const finishPasskeyRegistration = async (
  token: string,
  challengeId: string,
  response: Record<string, unknown>,
) =>
  (
    await api.post(
      `signing/sign/${apiPathSegment(token)}/passkey/register/verify`,
      { challengeId, response },
    )
  ).data as { verified: boolean };

const beginPasskeyAction = async (
  token: string,
  payload: PasskeyActionPayload,
) =>
  (
    await api.post(
      `signing/sign/${apiPathSegment(token)}/passkey/options`,
      payload,
    )
  ).data as {
    challengeId: string;
    intentHash: string;
    documentHash: string;
    options: Record<string, unknown>;
  };

const signDocument = async (
  token: string,
  data: {
    signatureData: string;
    signatureType: string;
    fieldValues?: { fieldId: string; value: string }[];
    passkeyChallengeId?: string;
    passkeyResponse?: Record<string, unknown>;
  },
): Promise<void> => {
  await api.post(`signing/sign/${apiPathSegment(token)}/sign`, data);
};

const rejectDocument = async (
  token: string,
  data: {
    reason?: string;
    passkeyChallengeId?: string;
    passkeyResponse?: Record<string, unknown>;
  },
): Promise<void> => {
  await api.post(`signing/sign/${apiPathSegment(token)}/reject`, data);
};

/**
 * Returns the URL to embed as an iframe for PDF preview (no auth needed).
 */
const getPreviewUrl = (token: string): string => {
  const base = api.defaults.baseURL || "/api";
  return `${base}/signing/sign/${apiPathSegment(token)}/preview`;
};

const getAuthenticatedPreviewUrl = (token: string): string => {
  const base = api.defaults.baseURL || "/api";
  return `${base}/signing/sign/${apiPathSegment(token)}/preview-authenticated`;
};

/**
 * Download the signed PDF using the signer's public token.
 */
const downloadSignedByToken = async (token: string): Promise<Blob> => {
  const response = await api.get(
    `signing/sign/${apiPathSegment(token)}/download-signed`,
    {
      responseType: "blob",
    },
  );
  return response.data;
};

const downloadSignedByTokenAuthenticated = async (
  token: string,
): Promise<Blob> => {
  const response = await api.get(
    `signing/sign/${apiPathSegment(token)}/download-signed-authenticated`,
    { responseType: "blob" },
  );
  return response.data;
};

/**
 * Download the original (encrypted) PDF for E2E finalization.
 */
const downloadOriginal = async (documentId: string): Promise<ArrayBuffer> => {
  const response = await api.get(
    `signing/documents/${apiPathSegment(documentId)}/original`,
    {
      responseType: "arraybuffer",
    },
  );
  return response.data;
};

export interface PaginatedTeamSignatures {
  documents: (SignatureRequest & { fileDeleted?: boolean })[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const getTeamDocuments = async (
  teamId: string,
  options: { page?: number; limit?: number } = {},
): Promise<PaginatedTeamSignatures> => {
  const params = new URLSearchParams();
  if (options.page) params.set("page", String(options.page));
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  const response = await api.get(
    `signing/team/${apiPathSegment(teamId)}${query ? `?${query}` : ""}`,
  );
  return response.data;
};

/**
 * Retry server-side finalization for a non-E2E document stuck in AWAITING_FINALIZATION.
 */
const retryFinalize = async (
  documentId: string,
): Promise<{ status: string }> => {
  const response = await api.post(
    `signing/documents/${apiPathSegment(documentId)}/retry-finalize`,
  );
  return response.data;
};

const signingService = {
  createRequest,
  getMyDocuments,
  getReceivedDocuments,
  getTeamDocuments,
  getDocument,
  cancelDocument,
  sendReminder,
  downloadSigned,
  downloadOriginal,
  getAuditTrail,
  getSignaturesForFinalization,
  getE2ECertificatePage,
  signE2EDigest,
  finalizeE2E,
  retryFinalize,
  getSigningPage,
  sendSigningEmailOtp,
  verifySigningEmailOtp,
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  beginPasskeyAction,
  signDocument,
  rejectDocument,
  getPreviewUrl,
  getAuthenticatedPreviewUrl,
  downloadSignedByToken,
  downloadSignedByTokenAuthenticated,
};

export default signingService;
