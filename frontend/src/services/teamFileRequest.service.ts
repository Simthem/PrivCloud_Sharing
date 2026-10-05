import {
  batchGetPublicKeys,
  encryptNotificationMetadata,
} from "./crypto.service";
import teamService from "./team.service";
import { selectPqNotificationPublicKey } from "../utils/pqNotification.util";
import api from "./api.service";
import { apiPathSegment } from "../utils/apiPath.util";
import { importKeyFromBase64 } from "../utils/crypto.util";
import { encryptFileRequestInfo } from "../utils/fileMetadata.util";

export type FileRequestUser = { id: string; username: string; email: string };
export type FileRequestFolder = {
  id: string;
  name: string;
  parentId: string | null;
  recipients: Array<FileRequestUser & { canUpload: boolean }>;
};
export type TeamFileRequest = {
  id: string;
  teamId: string;
  folderId: string | null;
  subject: string;
  note: string | null;
  /** Subject and note encrypted with K_team, see useFileRequestInfos. */
  encryptedInfo?: string | null;
  creatorId: string;
  creator: FileRequestUser;
  folder: { id: string; name: string } | null;
  expiresAt: string;
  createdAt: string;
  status: "OPEN" | "CLOSED" | "EXPIRED";
  canWrite: boolean;
  canRespond: boolean;
  recipients: Array<{ user: FileRequestUser; fileCount: number }>;
};
export type CreateTeamFileRequest = {
  folderId: string;
  subject: string;
  note?: string;
  recipientIds: string[];
  expiresAt?: string;
  recipientScope: "ALL" | "SELECTED";
  sendEmail: boolean;
};
const base = (teamId: string) =>
  `teams/${apiPathSegment(teamId)}/file-requests`;
const teamFileRequestService = {
  options: async (teamId: string): Promise<FileRequestFolder[]> =>
    (await api.get(`${base(teamId)}/options`)).data,
  list: async (
    teamId: string,
    offset = 0,
  ): Promise<{ requests: TeamFileRequest[]; total: number }> =>
    (await api.get(base(teamId), { params: { offset } })).data,
  get: async (teamId: string, requestId: string): Promise<TeamFileRequest> =>
    (await api.get(`${base(teamId)}/${apiPathSegment(requestId)}`)).data,
  /**
   * With `teamKey` (K_team, base64url), the subject and note are encrypted
   * with it and the server only gets an empty subject.
   */
  create: async (
    teamId: string,
    dto: CreateTeamFileRequest,
    creatorId: string,
    teamKey?: string | null,
  ): Promise<{ id: string }> => {
    const team = await teamService.getTeam(teamId);
    const id = crypto.randomUUID();
    const encryptedInfo = teamKey
      ? await encryptFileRequestInfo(await importKeyFromBase64(teamKey), id, {
          subject: dto.subject,
          ...(dto.note && { note: dto.note }),
        })
      : undefined;
    const members = team.members || [];
    const recipientIds =
      dto.recipientScope === "ALL"
        ? members
            .filter((m) => m.isActive && m.userId !== creatorId)
            .map((m) => m.userId)
        : dto.recipientIds;
    const targets = members.filter(
      (m) =>
        m.isActive &&
        m.pushNotifMode === "EVERY_FILE" &&
        (recipientIds.includes(m.userId) || m.userId === creatorId),
    );
    const keys = (
      await Promise.all(
        Array.from({ length: Math.ceil(targets.length / 100) }, (_, index) =>
          batchGetPublicKeys(
            targets.slice(index * 100, index * 100 + 100).map((m) => m.userId),
          ),
        ),
      )
    ).flat();
    const metadata = {
      action: "FILE_REQUEST",
      actionUrl: `/team/${teamId}?fileRequests=1`,
      subject: dto.subject,
    };
    const encryptFor = async (userId: string, action: string) => {
      const key = keys.find((k) => k.userId === userId);
      if (!key?.x25519) throw new Error("team.fileRequest.error.keys");
      return encryptNotificationMetadata(
        { ...metadata, action },
        key.x25519.publicKey,
        selectPqNotificationPublicKey(
          !!team.pqNotificationEncryptionEnabled,
          key.pqKey?.publicKey,
        ),
      );
    };
    const notifications = await Promise.all(
      targets
        .filter((m) => m.userId !== creatorId)
        .map(async (m) => ({
          userId: m.userId,
          encryptedMetadata: await encryptFor(m.userId, "FILE_REQUEST"),
        })),
    );
    const submissionNotification = targets.some((m) => m.userId === creatorId)
      ? await encryptFor(creatorId, "FILE_REQUEST_SUBMITTED")
      : undefined;
    return (
      await api.post(base(teamId), {
        ...dto,
        ...(encryptedInfo && { subject: "", note: undefined, encryptedInfo }),
        id,
        recipientIds,
        notifications,
        submissionNotification,
      })
    ).data;
  },
  close: async (teamId: string, requestId: string) =>
    (await api.patch(`${base(teamId)}/${apiPathSegment(requestId)}/close`))
      .data,
};
export default teamFileRequestService;
