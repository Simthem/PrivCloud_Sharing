import { startAuthentication } from "@simplewebauthn/browser";
import api from "./api.service";
import { apiPathSegment } from "../utils/apiPath.util";
import type { ExternalIssuance, ExternalJournal } from "./teamExternal.service";

export type VaultStatus = { open: boolean; openUntil: string | null };

export type VaultTeam = {
  teamId: string;
  teamName: string;
  teamExists: boolean;
  copies: number;
  lastIssuedAt: string | null;
};

const base = "admin/evidence-vault";
const entry = (teamId: string, issuanceId: string) =>
  `${base}/teams/${apiPathSegment(teamId)}/issuances/${apiPathSegment(issuanceId)}`;

const status = async (): Promise<VaultStatus> =>
  (await api.get(`${base}/status`)).data;

/** Opens the vault for a few minutes, after a fresh passkey verification. */
const unlock = async (): Promise<VaultStatus> => {
  const ceremony: { challengeId: string; options: Record<string, unknown> } = (
    await api.post(`${base}/unlock/options`)
  ).data;
  const response = await startAuthentication({
    optionsJSON: ceremony.options as unknown as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"],
  });
  return (
    await api.post(`${base}/unlock`, {
      challengeId: ceremony.challengeId,
      response,
    })
  ).data;
};

const lock = async (): Promise<void> => {
  await api.post(`${base}/lock`);
};

const teams = async (search: string): Promise<VaultTeam[]> =>
  (
    await api.get(`${base}/teams`, {
      params: search ? { search } : undefined,
    })
  ).data;

const issuances = async (teamId: string): Promise<ExternalIssuance[]> =>
  (await api.get(`${base}/teams/${apiPathSegment(teamId)}/issuances`)).data;

const certificate = async (teamId: string, issuanceId: string): Promise<Blob> =>
  (
    await api.get(`${entry(teamId, issuanceId)}/certificate`, {
      responseType: "blob",
    })
  ).data;

const evidence = async (teamId: string, issuanceId: string): Promise<Blob> =>
  (
    await api.get(`${entry(teamId, issuanceId)}/evidence`, {
      responseType: "blob",
    })
  ).data;

const journal = async (
  teamId: string,
  issuanceId: string,
): Promise<ExternalJournal> =>
  (await api.get(`${entry(teamId, issuanceId)}/journal`)).data;

/** Early erasure of a deleted team's evidence, on the customer's request. */
const erase = async (teamId: string, confirmation: string) =>
  (
    await api.post(`${base}/teams/${apiPathSegment(teamId)}/erase`, {
      confirmation,
    })
  ).data as { issuances: number; events: number; anchors: number };

const evidenceVaultService = {
  status,
  unlock,
  lock,
  teams,
  issuances,
  certificate,
  evidence,
  journal,
  erase,
};

export default evidenceVaultService;
