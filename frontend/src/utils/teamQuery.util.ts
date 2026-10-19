// Team views whose content changes when a share enters or leaves a folder.
const TEAM_FOLDER_CONTENT_QUERY_ROOTS = [
  "team.folder.shares",
  "team.folders",
  "team.metrics",
  "team.searchIndex",
  "team.logs",
  "team-shares",
  "team.signatures",
] as const;

export const getTeamFolderContentQueryKeys = (
  teamId: string,
  folderId: string,
) =>
  TEAM_FOLDER_CONTENT_QUERY_ROOTS.map((root) =>
    root === "team.folder.shares" ? [root, teamId, folderId] : [root, teamId],
  );

/** Prefixes matching those views in every team, for callers without ids. */
export const getAllTeamFolderContentQueryKeys = () =>
  TEAM_FOLDER_CONTENT_QUERY_ROOTS.map((root) => [root]);
