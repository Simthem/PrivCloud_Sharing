import api from "./api.service";

export interface Team {
  id: string;
  name: string;
  slug: string;
  description?: string;
  plan?: string;
  status?: string;
  maxMembers: number;
  maxShareSize: number;
  totalStorageLimit: number;
  storageUsed: number;
  members?: TeamMember[];
  sharedFolders?: TeamFolder[];
  createdAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  hasTeamKey?: boolean;
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
    limit: number;
    percentage: number;
  };
  activity: {
    totalFiles: number;
    recentActivity: number;
    downloads: number;
    uploads: number;
    signatures: number;
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
  return (await api.get(`teams/${teamId}`)).data;
};

const updateTeam = async (
  teamId: string,
  data: { name?: string; description?: string; reportFrequency?: string },
): Promise<Team> => {
  return (await api.patch(`teams/${teamId}`, data)).data;
};

const deleteTeam = async (teamId: string, confirmationName: string): Promise<void> => {
  await api.delete(`teams/${teamId}`, { data: { confirmationName } });
};

// ============================================================
// Members
// ============================================================

const inviteMember = async (
  teamId: string,
  data: { email: string; role?: string; encryptedTeamKey?: string },
): Promise<{ invited: boolean; email: string; invitationToken: string }> => {
  return (await api.post(`teams/${teamId}/members/invite`, data)).data;
};

const acceptInvitation = async (
  token: string,
  wrappedTeamKey?: string,
): Promise<{ teamId: string; teamName: string; encryptedTeamKey: string | null }> => {
  return (await api.post(`teams/invite/${token}/accept`, { wrappedTeamKey })).data;
};

const getTeamKey = async (
  teamId: string,
): Promise<{ wrappedTeamKey: string | null }> => {
  return (await api.get(`teams/${teamId}/team-key`)).data;
};

const setTeamKey = async (
  teamId: string,
  wrappedTeamKey: string,
): Promise<void> => {
  await api.put(`teams/${teamId}/team-key`, { wrappedTeamKey });
};

export interface TeamShare {
  id: string;
  isE2EEncrypted: boolean;
  files: { id: string; name: string; size: string }[];
}

const getTeamShares = async (teamId: string): Promise<TeamShare[]> => {
  return (await api.get(`teams/${teamId}/shares`)).data;
};

const rotateTeamKey = async (
  teamId: string,
  newWrappedTeamKey: string,
): Promise<void> => {
  await api.post(`teams/${teamId}/rotate-team-key`, { newWrappedTeamKey });
};

const removeMember = async (
  teamId: string,
  memberId: string,
): Promise<void> => {
  await api.delete(`teams/${teamId}/members/${memberId}`);
};

const leaveTeam = async (teamId: string): Promise<void> => {
  await api.post(`teams/${teamId}/leave`);
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
  return (await api.get(`teams/${teamId}/members/${memberId}/folder-access`)).data;
};

const updateMemberRole = async (
  teamId: string,
  memberId: string,
  role: string,
): Promise<void> => {
  await api.patch(`teams/${teamId}/members/${memberId}/role`, { role });
};

const updateMemberPermissions = async (
  teamId: string,
  memberId: string,
  permissions: { canViewActivity?: boolean; canViewSignatures?: boolean; pushNotifMode?: string },
): Promise<void> => {
  await api.patch(`teams/${teamId}/members/${memberId}/permissions`, permissions);
};

const updateMyPreferences = async (
  teamId: string,
  preferences: { pushNotifMode?: string },
): Promise<{ updated: boolean; pushNotifMode?: string }> => {
  return (await api.patch(`teams/${teamId}/my-preferences`, preferences)).data;
};

// ============================================================
// Folders
// ============================================================

const createFolder = async (
  teamId: string,
  data: { name: string; description?: string; parentId?: string; color?: string },
): Promise<TeamFolder> => {
  return (await api.post(`teams/${teamId}/folders`, data)).data;
};

const getFolders = async (
  teamId: string,
  parentId?: string,
): Promise<TeamFolder[]> => {
  const params = parentId ? `?parentId=${parentId}` : "";
  return (await api.get(`teams/${teamId}/folders${params}`)).data;
};

const setFolderAccess = async (
  teamId: string,
  folderId: string,
  data: { memberId: string; permission: string; canRequestSignature?: boolean; canShareE2E?: boolean },
): Promise<void> => {
  await api.post(`teams/${teamId}/folders/${folderId}/access`, data);
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
  return (await api.get(`teams/${teamId}/folders/${folderId}/access`)).data;
};

const removeFolderAccess = async (
  teamId: string,
  folderId: string,
  memberId: string,
): Promise<void> => {
  await api.delete(`teams/${teamId}/folders/${folderId}/access/${memberId}`);
};

const deleteFolder = async (
  teamId: string,
  folderId: string,
  confirmationName: string,
): Promise<void> => {
  await api.delete(`teams/${teamId}/folders/${folderId}`, { data: { confirmationName } });
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
  myAccess?: { permission: string; canDownload: boolean; canDelete: boolean; canRequestSignature: boolean; canShareE2E: boolean } | null;
  myFileAccess?: Record<string, { permission: string; canRequestSignature: boolean; canShareE2E: boolean }>;
}> => {
  return (await api.get(`teams/${teamId}/folders/${folderId}/shares`)).data;
};

// ============================================================
// File-level access
// ============================================================

const setFileAccess = async (
  teamId: string,
  folderId: string,
  data: {
    fileIds: string[];
    members: { memberId: string; permission: string; canRequestSignature?: boolean; canShareE2E?: boolean }[];
  },
): Promise<{ set: boolean; filesCount: number; membersCount: number }> => {
  return (await api.post(`teams/${teamId}/folders/${folderId}/file-access`, data)).data;
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
  return (await api.get(`teams/${teamId}/folders/${folderId}/file-access`)).data;
};

const bulkDeleteFiles = async (
  teamId: string,
  folderId: string,
  files: { shareId: string; fileId: string }[],
): Promise<{ deleted: number; total: number }> => {
  return (await api.post(`teams/${teamId}/folders/${folderId}/bulk-delete`, { files })).data;
};

// ============================================================
// Metrics & Logs
// ============================================================

const getMetrics = async (teamId: string): Promise<TeamMetrics> => {
  return (await api.get(`teams/${teamId}/metrics`)).data;
};

const getAccessLogs = async (
  teamId: string,
  options?: { page?: number; limit?: number; action?: string },
): Promise<{
  logs: AccessLog[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> => {
  const params = new URLSearchParams();
  if (options?.page) params.set("page", String(options.page));
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.action) params.set("action", options.action);
  const qs = params.toString();
  return (await api.get(`teams/${teamId}/logs${qs ? `?${qs}` : ""}`)).data;
};

/** Returns all team folders the user can write to (for share upload flow) */
const getMyWritableFolders = async (): Promise<
  { teamId: string; teamName: string; folder: TeamFolder }[]
> => {
  const teams = await getMyTeams();
  const results: { teamId: string; teamName: string; folder: TeamFolder }[] = [];
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
        if (folder.myPermission && folder.myPermission !== "READ" && folder.myPermission !== "NONE") {
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
  getSignableFiles,
};

export default teamService;
