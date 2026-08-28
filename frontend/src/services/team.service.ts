import api from "./api.service";
import { apiPathSegment } from "../utils/apiPath.util";

export interface Team {
  id: string;
  name: string;
  slug: string;
  description?: string;
  maxMembers: number;
  maxShareSize: number;
  totalStorageLimit: number;
  storageUsed: number;
  members?: TeamMember[];
  sharedFolders?: TeamFolder[];
  reportEnabled: boolean;
  reportFrequency: string;
  keyVersion: number;
  keyRotatedAt?: string | null;
  keyRotationIntervalDays: number;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  hasTeamKey?: boolean;
  teamKeyVersion?: number;
  keyStatus?: "CURRENT" | "PENDING" | "MISSING";
  canViewActivity?: boolean;
  canViewSignatures?: boolean;
  pushNotifMode?: string;
  user?: { id: string; username: string; email: string };
}

export interface TeamFolder {
  id: string;
  name: string;
  description?: string;
  parentId?: string;
  color?: string;
  myPermission?: string;
  _count?: { shares: number; children: number };
}

export interface TeamMetrics {
  team: {
    name: string;
    membersCount: number;
    maxMembers: number;
    foldersCount: number;
  };
  storage: {
    used: number;
    folderUsed: number;
    externalUsed: number;
    limit: number;
    percentage: number;
  };
  activity: {
    totalFiles: number;
    recentActivity: number;
    downloads: number;
    uploads: number;
    signatures: number;
    dailyBreakdown: Array<{ action: string; _count: { id: number } }>;
    topDownloaders: { email: string; count: number }[];
  };
  limits: {
    maxShareSize: number;
    totalStorage: number;
  };
}

export interface AccessLog {
  id: string;
  action: string;
  actorEmail: string;
  actorName?: string;
  fileName?: string;
  fileSize?: number;
  ipAddress?: string;
  createdAt: string;
  folder?: { name: string };
  file?: { name: string };
}

export interface TeamAuditReport {
  id: string;
  frequency: string;
  periodStart: string;
  periodEnd: string;
  status: "GENERATED" | "SENT" | "FAILED";
  sentAt?: string | null;
  error?: string | null;
  recipientEmails: string[];
  summary: null | {
    totals: Record<string, number>;
    anomalies: Array<{ code: string; severity: string; description: string }>;
    keyHealth: { current: number; pending: number; missing: number };
  };
}

export interface TeamSearchIndex {
  generatedAt: string;
  mode: "CLIENT_SIDE_METADATA";
  folders: Array<{
    id: string;
    name: string;
    description?: string | null;
    parentId?: string | null;
    createdAt: string;
  }>;
  files: Array<{
    id: string;
    shareId: string;
    shareName?: string | null;
    folderId: string;
    folderName?: string | null;
    name: string;
    relativePath?: string | null;
    size: string;
    createdAt: string;
    expiresAt: string;
    author?: { id: string; username: string; email: string } | null;
    isE2EEncrypted: boolean;
    signature?: { id: string; status: string } | null;
  }>;
  signatures: Array<{
    id: string;
    fileId?: string | null;
    name: string;
    status: string;
    createdAt: string;
    author?: { username: string; email: string } | null;
  }>;
  activity: AccessLog[];
  capabilities: { canViewActivity: boolean; canViewSignatures: boolean };
}

// ============================================================
// Team CRUD
// ============================================================

const create = async (data: {
  name: string;
  slug?: string;
  description?: string;
}): Promise<Team> => {
  return (await api.post("teams", data)).data;
};

const getMyTeams = async (): Promise<Team[]> => {
  return (await api.get("teams")).data;
};

const getTeamStatus = async (): Promise<{
  ownsTeam: boolean;
  isTeamAdmin: boolean;
  isTeamMember: boolean;
  needsTeamCreation: boolean;
  ownedTeamId: string | null;
  teamId: string | null;
  teamName: string | null;
  teamStorageLimit: number | null;
  teamStorageUsed: number | null;
  teams: {
    teamId: string;
    teamName: string;
    role: string;
    storageLimit: number;
    storageUsed: number;
  }[];
}> => {
  return (await api.get("teams/status")).data;
};

const getTeam = async (teamId: string): Promise<Team> => {
  return (await api.get(`teams/${apiPathSegment(teamId)}`)).data;
};

const updateTeam = async (
  teamId: string,
  data: {
    name?: string;
    description?: string;
    reportFrequency?: string;
    reportEnabled?: boolean;
    keyRotationIntervalDays?: number;
  },
): Promise<Team> => {
  return (await api.patch(`teams/${apiPathSegment(teamId)}`, data)).data;
};

const deleteTeam = async (
  teamId: string,
  confirmationName: string,
): Promise<void> => {
  await api.delete(`teams/${apiPathSegment(teamId)}`, {
    data: { confirmationName },
  });
};

// ============================================================
// Members
// ============================================================

const inviteMember = async (
  teamId: string,
  data: { email: string; role?: string; encryptedTeamKey?: string },
): Promise<{ invited: boolean; email: string; invitationToken: string }> => {
  return (
    await api.post(`teams/${apiPathSegment(teamId)}/members/invite`, data)
  ).data;
};

const acceptInvitation = async (
  token: string,
  wrappedTeamKey?: string,
  keyVersion?: number,
): Promise<{
  teamId: string;
  teamName: string;
  encryptedTeamKey: string | null;
}> => {
  return (
    await api.post(`teams/invite/${apiPathSegment(token)}/accept`, {
      wrappedTeamKey,
      keyVersion,
    })
  ).data;
};

const getTeamKey = async (
  teamId: string,
): Promise<{
  wrappedTeamKey: string | null;
  keyVersion: number;
  memberKeyVersion: number;
}> => {
  return (await api.get(`teams/${apiPathSegment(teamId)}/team-key`)).data;
};

const setTeamKey = async (
  teamId: string,
  wrappedTeamKey: string,
  keyVersion?: number,
): Promise<void> => {
  await api.put(`teams/${apiPathSegment(teamId)}/team-key`, {
    wrappedTeamKey,
    keyVersion,
  });
};

const clearTeamKey = async (teamId: string): Promise<void> => {
  await api.delete(`teams/${apiPathSegment(teamId)}/team-key`);
};

export interface TeamShare {
  id: string;
  isE2EEncrypted: boolean;
  files: { id: string; name: string; size: string }[];
}

const getTeamShares = async (teamId: string): Promise<TeamShare[]> => {
  return (await api.get(`teams/${apiPathSegment(teamId)}/shares`)).data;
};

const rotateTeamKey = async (
  teamId: string,
  newWrappedTeamKey: string,
): Promise<void> => {
  await api.post(`teams/${apiPathSegment(teamId)}/rotate-team-key`, {
    newWrappedTeamKey,
  });
};

export interface TeamKeyRotationStatus {
  policy: {
    intervalDays: number;
    reminderDays: number;
    currentVersion: number;
    lastRotatedAt: string | null;
    nextDueAt: string;
    reminderAt: string;
    isDue: boolean;
    reminderActive: boolean;
  };
  canOrchestrate: boolean;
  activeRotation: null | {
    id: string;
    fromVersion: number;
    toVersion: number;
    status: "PREPARING" | "REENCRYPTING" | "PAUSED";
    reason: "MANUAL" | "POLICY";
    startedById: string;
    totalFiles: number;
    processedFiles: number;
    failedFiles: number;
    completedFileIds: string[];
    errorMessage: string | null;
    createdAt: string;
    pendingWrappedTeamKey: string | null;
    canResume: boolean;
  };
}

const getKeyRotationStatus = async (
  teamId: string,
): Promise<TeamKeyRotationStatus> =>
  (await api.get(`teams/${apiPathSegment(teamId)}/key-rotation`)).data;

const startKeyRotation = async (
  teamId: string,
  data: { newWrappedTeamKey: string; reason: "MANUAL" | "POLICY" },
): Promise<NonNullable<TeamKeyRotationStatus["activeRotation"]>> =>
  (await api.post(`teams/${apiPathSegment(teamId)}/key-rotation/start`, data))
    .data;

const updateKeyRotationProgress = async (
  teamId: string,
  rotationId: string,
  data: {
    completedFileId?: string;
    failedFiles?: number;
    status?: "REENCRYPTING" | "PAUSED";
    errorMessage?: string;
  },
): Promise<NonNullable<TeamKeyRotationStatus["activeRotation"]>> =>
  (
    await api.patch(
      `teams/${apiPathSegment(teamId)}/key-rotation/${apiPathSegment(rotationId)}/progress`,
      data,
    )
  ).data;

const completeKeyRotation = async (
  teamId: string,
  rotationId: string,
): Promise<{ success: boolean; keyVersion: number }> =>
  (
    await api.post(
      `teams/${apiPathSegment(teamId)}/key-rotation/${apiPathSegment(rotationId)}/complete`,
    )
  ).data;

const cancelKeyRotation = async (teamId: string, rotationId: string) => {
  await api.delete(
    `teams/${apiPathSegment(teamId)}/key-rotation/${apiPathSegment(rotationId)}`,
  );
};

const removeMember = async (
  teamId: string,
  memberId: string,
): Promise<void> => {
  await api.delete(
    `teams/${apiPathSegment(teamId)}/members/${apiPathSegment(memberId)}`,
  );
};

const leaveTeam = async (teamId: string): Promise<void> => {
  await api.post(`teams/${apiPathSegment(teamId)}/leave`);
};

const getMemberFolderAccess = async (
  teamId: string,
  memberId: string,
): Promise<{
  member: {
    id: string;
    role: string;
    user: { id: string; username: string; email: string };
  };
  folders: {
    id: string;
    name: string;
    color: string | null;
    permission: string | null;
  }[];
}> => {
  return (
    await api.get(
      `teams/${apiPathSegment(teamId)}/members/${apiPathSegment(memberId)}/folder-access`,
    )
  ).data;
};

const updateMemberRole = async (
  teamId: string,
  memberId: string,
  role: string,
): Promise<void> => {
  await api.patch(
    `teams/${apiPathSegment(teamId)}/members/${apiPathSegment(memberId)}/role`,
    { role },
  );
};

const updateMemberPermissions = async (
  teamId: string,
  memberId: string,
  permissions: {
    canViewActivity?: boolean;
    canViewSignatures?: boolean;
    pushNotifMode?: string;
  },
): Promise<void> => {
  await api.patch(
    `teams/${apiPathSegment(teamId)}/members/${apiPathSegment(memberId)}/permissions`,
    permissions,
  );
};

const updateMyPreferences = async (
  teamId: string,
  preferences: { pushNotifMode?: string },
): Promise<{ updated: boolean; pushNotifMode?: string }> => {
  return (
    await api.patch(
      `teams/${apiPathSegment(teamId)}/my-preferences`,
      preferences,
    )
  ).data;
};

// ============================================================
// Folders
// ============================================================

const createFolder = async (
  teamId: string,
  data: {
    name: string;
    description?: string;
    parentId?: string;
    color?: string;
  },
): Promise<TeamFolder> => {
  return (await api.post(`teams/${apiPathSegment(teamId)}/folders`, data)).data;
};

const getFolders = async (
  teamId: string,
  parentId?: string,
): Promise<TeamFolder[]> => {
  const params = parentId ? `?parentId=${parentId}` : "";
  return (await api.get(`teams/${apiPathSegment(teamId)}/folders${params}`))
    .data;
};

const setFolderAccess = async (
  teamId: string,
  folderId: string,
  data: {
    memberId: string;
    permission: string;
    canRequestSignature?: boolean;
    canShareE2E?: boolean;
  },
): Promise<void> => {
  await api.post(
    `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/access`,
    data,
  );
};

const getFolderAccess = async (
  teamId: string,
  folderId: string,
): Promise<
  {
    id: string;
    memberId: string;
    permission: string;
    canDownload: boolean;
    canDelete: boolean;
    canRequestSignature: boolean;
    canShareE2E: boolean;
    user: { id: string; username: string; email: string };
    role: string;
  }[]
> => {
  return (
    await api.get(
      `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/access`,
    )
  ).data;
};

const removeFolderAccess = async (
  teamId: string,
  folderId: string,
  memberId: string,
): Promise<void> => {
  await api.delete(
    `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/access/${apiPathSegment(memberId)}`,
  );
};

const deleteFolder = async (
  teamId: string,
  folderId: string,
  confirmationName: string,
): Promise<void> => {
  await api.delete(
    `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}`,
    { data: { confirmationName } },
  );
};

const getFolderShares = async (
  teamId: string,
  folderId: string,
): Promise<{
  folder: TeamFolder;
  shares: {
    id: string;
    name?: string;
    description?: string;
    createdAt: string;
    expiration?: string;
    isE2EEncrypted: boolean;
    files: {
      id: string;
      name: string;
      relativePath?: string | null;
      size: string;
      createdAt: string;
    }[];
    creator?: { id: string; username: string; email: string };
  }[];
  myAccess?: {
    permission: string;
    canDownload: boolean;
    canDelete: boolean;
    canRequestSignature: boolean;
    canShareE2E: boolean;
  } | null;
  myFileAccess?: Record<
    string,
    { permission: string; canRequestSignature: boolean; canShareE2E: boolean }
  >;
}> => {
  return (
    await api.get(
      `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/shares`,
    )
  ).data;
};

// ============================================================
// File-level access
// ============================================================

const setFileAccess = async (
  teamId: string,
  folderId: string,
  data: {
    fileIds: string[];
    members: {
      memberId: string;
      permission: string;
      canRequestSignature?: boolean;
      canShareE2E?: boolean;
    }[];
  },
): Promise<{ set: boolean; filesCount: number; membersCount: number }> => {
  return (
    await api.post(
      `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/file-access`,
      data,
    )
  ).data;
};

const getFileAccess = async (
  teamId: string,
  folderId: string,
): Promise<
  {
    id: string;
    fileId: string;
    fileName: string;
    memberId: string;
    permission: string;
    canRequestSignature: boolean;
    canShareE2E: boolean;
    user: { id: string; username: string; email: string };
    role: string;
  }[]
> => {
  return (
    await api.get(
      `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/file-access`,
    )
  ).data;
};

const bulkDeleteFiles = async (
  teamId: string,
  folderId: string,
  files: { shareId: string; fileId: string }[],
): Promise<{ deleted: number; total: number }> => {
  return (
    await api.post(
      `teams/${apiPathSegment(teamId)}/folders/${apiPathSegment(folderId)}/bulk-delete`,
      { files },
    )
  ).data;
};

// ============================================================
// Metrics & Logs
// ============================================================

const getMetrics = async (teamId: string): Promise<TeamMetrics> => {
  return (await api.get(`teams/${apiPathSegment(teamId)}/metrics`)).data;
};

const getAccessLogs = async (
  teamId: string,
  options?: { page?: number; limit?: number; action?: string },
): Promise<{
  logs: AccessLog[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}> => {
  const params = new URLSearchParams();
  if (options?.page) params.set("page", String(options.page));
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.action) params.set("action", options.action);
  const qs = params.toString();
  return (
    await api.get(`teams/${apiPathSegment(teamId)}/logs${qs ? `?${qs}` : ""}`)
  ).data;
};

const getAuditReports = async (teamId: string): Promise<TeamAuditReport[]> =>
  (await api.get(`teams/${apiPathSegment(teamId)}/audit-reports`)).data;

const sendAuditReportNow = async (teamId: string): Promise<TeamAuditReport> =>
  (await api.post(`teams/${apiPathSegment(teamId)}/audit-reports/send-now`))
    .data;

const getSearchIndex = async (teamId: string): Promise<TeamSearchIndex> =>
  (await api.get(`teams/${apiPathSegment(teamId)}/search-index`)).data;

/** Returns all team folders the user can write to (for share upload flow) */
const getMyWritableFolders = async (): Promise<
  { teamId: string; teamName: string; folder: TeamFolder }[]
> => {
  const teams = await getMyTeams();
  const results: { teamId: string; teamName: string; folder: TeamFolder }[] =
    [];
  const settled = await Promise.allSettled(
    teams.map(async (team) => {
      const folders = await getFolders(team.id);
      return { team, folders };
    }),
  );
  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { team, folders } = result.value;
      for (const folder of folders) {
        // Only include folders where the user has WRITE or ADMIN permission
        if (
          folder.myPermission &&
          folder.myPermission !== "READ" &&
          folder.myPermission !== "NONE"
        ) {
          results.push({ teamId: team.id, teamName: team.name, folder });
        }
      }
    }
  }
  return results;
};

export interface SignableFile {
  teamId: string;
  teamName: string;
  folderId: string;
  folderName: string;
  shareId: string;
  fileId: string;
  fileName: string;
}

const getSignableFiles = async (): Promise<SignableFile[]> => {
  return (await api.get("teams/signable-files")).data;
};

const teamService = {
  create,
  getMyTeams,
  getTeamStatus,
  getTeam,
  updateTeam,
  deleteTeam,
  inviteMember,
  acceptInvitation,
  getTeamKey,
  setTeamKey,
  clearTeamKey,
  removeMember,
  leaveTeam,
  getMemberFolderAccess,
  updateMemberRole,
  updateMemberPermissions,
  updateMyPreferences,
  createFolder,
  getFolders,
  setFolderAccess,
  getFolderAccess,
  removeFolderAccess,
  deleteFolder,
  getFolderShares,
  setFileAccess,
  getFileAccess,
  bulkDeleteFiles,
  getMetrics,
  getAccessLogs,
  getMyWritableFolders,
  getTeamShares,
  rotateTeamKey,
  getKeyRotationStatus,
  startKeyRotation,
  updateKeyRotationProgress,
  completeKeyRotation,
  cancelKeyRotation,
  getSignableFiles,
  getAuditReports,
  sendAuditReportNow,
  getSearchIndex,
};

export default teamService;
