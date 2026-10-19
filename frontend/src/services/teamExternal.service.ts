import api from "./api.service"
import { apiPathSegment } from "../utils/apiPath.util"
import type { ExternalKeyWrapping } from "../utils/externalPreviewCrypto.util"
import { startAuthentication } from "@simplewebauthn/browser"

export type ExternalSeatStatus = "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED"
export type RevocationReminderMode = "NONE" | "EMAIL" | "PUSH" | "BOTH"

export type ExternalSeat = {
  id: string
  email: string
  displayName: string | null
  status: ExternalSeatStatus
  inviteExpiresAt: string
  accessExpiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
  previewCount: number
  reminderMode?: RevocationReminderMode
}

export type ExternalSeatList = {
  limit: number
  used: number
  seats: ExternalSeat[]
}

export type ExternalSeatKeys = {
  seatId: string
  email: string
  displayName: string
  accessExpiresAt: string
  x25519: { publicKey: string; version: number }
  pqKey: { publicKey: string; variant: string; version: number }
}

export type TeamExternalPreview = {
  id: string
  seatId: string
  sourceFileId: string | null
  sourceShareId: string | null
  pageCount: number
  status: "UPLOADING" | "READY"
  createdAt: string
  createdById: string | null
}

export type ContractorPreview = ExternalKeyWrapping & {
  id: string
  pageCount: number
  createdAt: string
  encryptedManifest: string
  teamName: string
  accessExpiresAt: string
}

export type ContractorStatus = {
  totpEnabled: boolean
  seats: { teamName: string; accessExpiresAt: string }[]
}

export type ExternalInvitation = {
  teamName: string
  email: string
  accessExpiresAt: string
  emailMatches: boolean
  totpEnabled: boolean
  keysReady: boolean
}

export type IssuancePage = {
  plainSha256: string
  cipherSha256: string
  width: number
  height: number
}

export type WebAuthnCeremony = {
  challengeId: string
  options: Record<string, unknown>
}

export type ExternalIssuance = {
  sourceSha256?: string
  robustMarkAlgorithm?: "privcloud:forensic-multiscale:v2"
  id: string
  issuedAt: string
  previewId: string
  seatId: string
  contractorEmail: string
  contractorName: string | null
  issuerEmail: string
  markId: string
  manifestHash: string
  encryptedLabel: string | null
  timestampedAt: string | null
  pageCount: number
  sourceFileId: string
  accessExpiresAt: string
  copyAvailable: boolean
}

export type ExternalAuditEvent = {
  seq: number
  at: string
  kind: "ISSUED" | "OPENED" | "PAGE" | "DELETED" | "REVOKED"
  previewId: string | null
  actorEmail: string
  pageIndex: number | null
  hash: string
}

export type ExternalJournal = {
  events: ExternalAuditEvent[]
  verification: {
    valid: boolean
    events: number
    brokenAtSeq: number | null
    reason?:
      | "content_hash_mismatch"
      | "genesis_mismatch"
      | "sequence_gap"
      | "previous_hash_mismatch"
      | "anchor_mismatch"
      | "anchor_ahead_of_head"
      | "format_downgrade"
      | null
    lastAnchorAt: string | null
  }
}

const adminBase = (teamId: string) => `teams/${apiPathSegment(teamId)}/external`

// ---------------------------------------------------------------------------
// Team administrators
// ---------------------------------------------------------------------------

const listSeats = async (teamId: string): Promise<ExternalSeatList> =>
  (await api.get(`${adminBase(teamId)}/seats`)).data

const inviteSeat = async (
  teamId: string,
  data: { email: string; displayName?: string; accessExpiresAt: string },
): Promise<{ seatId: string; inviteUrl: string }> =>
  (await api.post(`${adminBase(teamId)}/seats`, data)).data

const updateSeat = async (
  teamId: string,
  seatId: string,
  accessExpiresAt: string,
): Promise<void> => {
  await api.patch(`${adminBase(teamId)}/seats/${apiPathSegment(seatId)}`, {
    accessExpiresAt,
  })
}

const revokeSeat = async (teamId: string, seatId: string): Promise<void> => {
  await api.delete(`${adminBase(teamId)}/seats/${apiPathSegment(seatId)}`)
}

const getSeatKeys = async (
  teamId: string,
  seatId: string,
): Promise<ExternalSeatKeys> =>
  (await api.get(`${adminBase(teamId)}/seats/${apiPathSegment(seatId)}/keys`))
    .data

const listPreviews = async (teamId: string): Promise<TeamExternalPreview[]> =>
  (await api.get(`${adminBase(teamId)}/previews`)).data

const createPreview = async (
  teamId: string,
  data: ExternalKeyWrapping & {
    id: string
    seatId: string
    sourceFileId: string
    pageCount: number
    encryptedManifest: string
  },
): Promise<{ id: string }> =>
  (await api.post(`${adminBase(teamId)}/previews`, data)).data

const uploadPage = async (
  teamId: string,
  previewId: string,
  index: number,
  body: Uint8Array,
  signal?: AbortSignal,
): Promise<void> => {
  await api.put(
    `${adminBase(teamId)}/previews/${apiPathSegment(previewId)}/pages/${index}`,
    new Blob([body as Uint8Array<ArrayBuffer>]),
    { headers: { "Content-Type": "application/octet-stream" }, signal },
  )
}

const completePreview = async (
  teamId: string,
  previewId: string,
): Promise<void> => {
  await api.post(
    `${adminBase(teamId)}/previews/${apiPathSegment(previewId)}/complete`,
  )
}

const deletePreview = async (
  teamId: string,
  previewId: string,
): Promise<void> => {
  await api.delete(`${adminBase(teamId)}/previews/${apiPathSegment(previewId)}`)
}

/** Register entry of a copy and the passkey options approving it. */
const prepareIssuance = async (
  teamId: string,
  previewId: string,
  data: {
    markId: string
    sourceSha256: string
    pages: IssuancePage[]
    visibleMarkAlgorithm?: "privcloud:visible-copy:v1"
    robustMarkAlgorithm?: "privcloud:forensic-multiscale:v2"
  },
): Promise<WebAuthnCeremony & { manifestHash: string }> =>
  (
    await api.post(
      `${adminBase(teamId)}/previews/${apiPathSegment(previewId)}/issuance`,
      data,
    )
  ).data

const approveIssuance = async (
  teamId: string,
  previewId: string,
  data: {
    challengeId: string
    response: unknown
    encryptedLabel?: string
  },
): Promise<{ issuanceId: string }> =>
  (
    await api.post(
      `${adminBase(teamId)}/previews/${apiPathSegment(previewId)}/issuance/approve`,
      data,
    )
  ).data

const listIssuances = async (teamId: string): Promise<ExternalIssuance[]> =>
  (await api.get(`${adminBase(teamId)}/issuances`)).data

const downloadWithPasskey = async <T = Blob>(
  teamId: string,
  issuanceId: string,
  kind: "certificate" | "evidence" | "pattern",
  responseType: "blob" | "json" = "blob",
): Promise<T> => {
  const base = `${adminBase(teamId)}/issuances/${apiPathSegment(issuanceId)}`
  const ceremony: WebAuthnCeremony = (
    await api.post(`${base}/download/options`, { kind })
  ).data
  const response = await startAuthentication({
    optionsJSON: ceremony.options as unknown as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"],
  })
  return (
    await api.post(
      `${base}/${kind}`,
      { challengeId: ceremony.challengeId, response },
      { responseType },
    )
  ).data
}

const downloadCertificate = (teamId: string, issuanceId: string) =>
  downloadWithPasskey(teamId, issuanceId, "certificate")

const authorizePatternExport = (teamId: string, issuanceId: string) =>
  downloadWithPasskey<{ markId: string; robustMarkAlgorithm?: string }>(
    teamId,
    issuanceId,
    "pattern",
    "json",
  )

/** Certificate, preuve.json and RFC 3161 tokens in one ZIP. */
const downloadEvidence = (teamId: string, issuanceId: string) =>
  downloadWithPasskey(teamId, issuanceId, "evidence")

const setRevocationReminder = async (
  teamId: string,
  seatId: string,
  mode: RevocationReminderMode,
): Promise<void> => {
  await api.patch(
    `${adminBase(teamId)}/seats/${apiPathSegment(seatId)}/revocation-reminder`,
    { mode },
  )
}

const getJournal = async (
  teamId: string,
  previewId?: string,
): Promise<ExternalJournal> =>
  (
    await api.get(`${adminBase(teamId)}/journal`, {
      params: previewId ? { previewId } : undefined,
    })
  ).data

const getAuditKey = async (
  teamId: string,
): Promise<{ encryptedKey: string; keyVersion: number } | null> =>
  (await api.get(`${adminBase(teamId)}/audit-key`)).data || null

const getJournalDiagnostic = async (teamId: string): Promise<Blob> =>
  (
    await api.get(`${adminBase(teamId)}/journal/diagnostic`, {
      responseType: "blob",
    })
  ).data

const createAuditKey = async (
  teamId: string,
  data: { encryptedKey: string; keyVersion: number },
): Promise<void> => {
  await api.post(`${adminBase(teamId)}/audit-key`, data)
}

// ---------------------------------------------------------------------------
// External contractors
// ---------------------------------------------------------------------------

const getContractorStatus = async (): Promise<ContractorStatus> =>
  (await api.get("external/status")).data

const getInvitation = async (token: string): Promise<ExternalInvitation> =>
  (await api.get(`external/invitations/${apiPathSegment(token)}`)).data

/** Signed-out visitor of an invitation link: sign in or sign up. */
const getInvitationAccount = async (
  token: string,
): Promise<{ email: string; accountExists: boolean }> =>
  (await api.get(`external/invitations/${apiPathSegment(token)}/account`)).data

const acceptInvitation = async (
  token: string,
): Promise<{ teamName: string; accessExpiresAt: string }> =>
  (await api.post(`external/invitations/${apiPathSegment(token)}/accept`)).data

const listContractorPreviews = async (): Promise<ContractorPreview[]> =>
  (await api.get("external/previews")).data

const getContractorPreview = async (
  previewId: string,
): Promise<ContractorPreview> =>
  (await api.get(`external/previews/${apiPathSegment(previewId)}`)).data

const getContractorPage = async (
  previewId: string,
  index: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const response = await api.get(
    `external/previews/${apiPathSegment(previewId)}/pages/${index}`,
    { responseType: "arraybuffer", signal },
  )
  return new Uint8Array(response.data as ArrayBuffer)
}

const teamExternalService = {
  listSeats,
  inviteSeat,
  updateSeat,
  revokeSeat,
  setRevocationReminder,
  getSeatKeys,
  listPreviews,
  createPreview,
  uploadPage,
  completePreview,
  deletePreview,
  prepareIssuance,
  approveIssuance,
  listIssuances,
  downloadCertificate,
  authorizePatternExport,
  downloadEvidence,
  getJournal,
  getJournalDiagnostic,
  getAuditKey,
  createAuditKey,
  getContractorStatus,
  getInvitation,
  getInvitationAccount,
  acceptInvitation,
  listContractorPreviews,
  getContractorPreview,
  getContractorPage,
}

export default teamExternalService
