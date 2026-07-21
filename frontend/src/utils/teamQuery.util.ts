export const getTeamFolderContentQueryKeys = (
  teamId: string,
  folderId: string,
) => [
  ["team.folder.shares", teamId, folderId],
  ["team.folders", teamId],
  ["team.metrics", teamId],
  ["team.searchIndex", teamId],
  ["team.logs", teamId],
  ["team-shares", teamId],
  ["team.signatures", teamId],
];
