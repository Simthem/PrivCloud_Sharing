import api from "./api.service";

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
}

export interface SigningPageData {
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
    otpVerified?: boolean;
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
  pdfUrl: string;
  requiresOtp?: boolean;
}

export interface CreateSignatureRequestPayload {
  shareId: string;
  fileId: string;
  message?: string;
  signatureLevel?: "AES" | "QES";
  expiresAt?: string;
  addApprovalField?: boolean;
  addApprovalMention?: boolean;
  addInitials?: boolean;
  isE2EEncrypted?: boolean;
  sendE2EKeyByEmail?: boolean;
  e2eKey?: string;
  recipients: {
    name: string;
    email: string;
    role?: "SIGNER" | "APPROVER" | "CC";
    order?: number;
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
  return (await api.post("signing/request", data)).data;
};

const getMyDocuments = async (): Promise<SignatureRequest[]> => {
  return (await api.get("signing/documents")).data;
};

const getReceivedDocuments = async (): Promise<SignatureRequest[]> => {
  return (await api.get("signing/received")).data;
};

const getDocument = async (id: string): Promise<SignatureRequest> => {
  return (await api.get(`signing/documents/${id}`)).data;
};

const cancelDocument = async (id: string): Promise<void> => {
  await api.delete(`signing/documents/${id}`);
};

const sendReminder = async (id: string): Promise<void> => {
  await api.post(`signing/documents/${id}/remind`);
};

const downloadSigned = async (id: string): Promise<Blob> => {
  const response = await api.get(`signing/documents/${id}/download`, {
    responseType: "blob",
  });
  return response.data;
};

const getAuditTrail = async (id: string): Promise<any> => {
  return (await api.get(`signing/documents/${id}/audit`)).data;
};

const getSignaturesForFinalization = async (id: string): Promise<any> => {
  return (await api.get(`signing/documents/${id}/signatures`)).data;
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
  const res = (await api.post(`signing/documents/${id}/e2e-certificate-page`, {
    documentHash,
  })).data;
  return decodeBase64(res.certificatePage);
};

/** Send only the PDF ByteRange SHA-256 digest and receive its detached CMS. */
const signE2EDigest = async (id: string, digest: string): Promise<Uint8Array> => {
  const res = (await api.post(`signing/documents/${id}/sign-e2e-digest`, {
    digest,
  })).data;
  return decodeBase64(res.cms);
};

/**
 * E2E Step 2: Send re-encrypted signed PDF for storage.
 * Backend stores it and marks the document COMPLETED.
 */
const finalizeE2E = async (id: string, encryptedPdfBuffer: ArrayBuffer): Promise<any> => {
  const bytes = new Uint8Array(encryptedPdfBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return (await api.post(`signing/documents/${id}/finalize-e2e`, {
    encryptedPdf: base64,
  })).data;
};

// ============================================================
// Public (recipient token) endpoints
// ============================================================

const getSigningPage = async (token: string): Promise<SigningPageData> => {
  return (await api.get(`signing/sign/${token}`)).data;
};

const sendOtp = async (token: string): Promise<void> => {
  await api.post(`signing/sign/${token}/otp/send`);
};

const verifyOtp = async (
  token: string,
  code: string,
): Promise<{ verified: boolean }> => {
  return (await api.post(`signing/sign/${token}/otp/verify`, { otpCode: code })).data;
};

const signDocument = async (
  token: string,
  data: {
    signatureData: string;
    signatureType: string;
    otpCode?: string;
    fieldValues?: { fieldId: string; value: string }[];
  },
): Promise<void> => {
  await api.post(`signing/sign/${token}/sign`, data);
};

const rejectDocument = async (
  token: string,
  reason?: string,
): Promise<void> => {
  await api.post(`signing/sign/${token}/reject`, { reason });
};

/**
 * Returns the URL to embed as an iframe for PDF preview (no auth needed).
 */
const getPreviewUrl = (token: string): string => {
  const base = api.defaults.baseURL || "/api";
  return `${base}/signing/sign/${token}/preview`;
};

/**
 * Download the signed PDF using the signer's public token.
 */
const downloadSignedByToken = async (token: string): Promise<Blob> => {
  const response = await api.get(`signing/sign/${token}/download-signed`, {
    responseType: "blob",
  });
  return response.data;
};

/**
 * Download the original (encrypted) PDF for E2E finalization.
 */
const downloadOriginal = async (documentId: string): Promise<ArrayBuffer> => {
  const response = await api.get(`signing/documents/${documentId}/original`, {
    responseType: "arraybuffer",
  });
  return response.data;
};

export interface PaginatedTeamSignatures {
  documents: (SignatureRequest & { fileDeleted?: boolean })[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const getTeamDocuments = async (
  teamId: string,
  options: { page?: number; limit?: number } = {},
): Promise<PaginatedTeamSignatures> => {
  const params = new URLSearchParams();
  if (options.page) params.set("page", String(options.page));
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  const response = await api.get(`signing/team/${teamId}${query ? `?${query}` : ""}`);
  return response.data;
};

/**
 * Retry server-side finalization for a non-E2E document stuck in AWAITING_FINALIZATION.
 */
const retryFinalize = async (documentId: string): Promise<{ status: string }> => {
  const response = await api.post(`signing/documents/${documentId}/retry-finalize`);
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
  sendOtp,
  verifyOtp,
  signDocument,
  rejectDocument,
  getPreviewUrl,
  downloadSignedByToken,
};

export default signingService;
