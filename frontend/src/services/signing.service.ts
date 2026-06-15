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

/**
 * E2E Step 1: Send decrypted PDF (with visual signatures) to backend.
 * Backend applies certificate page + PAdES cryptographic signature.
 * Returns the signed PDF as base64 (NOT stored yet).
 */
const signE2EPdf = async (id: string, plaintextPdfBuffer: ArrayBuffer): Promise<ArrayBuffer> => {
  const bytes = new Uint8Array(plaintextPdfBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const res = (await api.post(`signing/documents/${id}/sign-e2e`, {
    plaintextPdf: base64,
  })).data;

  // Decode the signed PDF from base64
  const signedBinary = atob(res.signedPdf);
  const signedBytes = new Uint8Array(signedBinary.length);
  for (let i = 0; i < signedBinary.length; i++) {
    signedBytes[i] = signedBinary.charCodeAt(i);
  }
  return signedBytes.buffer as ArrayBuffer;
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

const getTeamDocuments = async (teamId: string): Promise<SignatureRequest[]> => {
  const response = await api.get(`signing/team/${teamId}`);
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
  signE2EPdf,
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
