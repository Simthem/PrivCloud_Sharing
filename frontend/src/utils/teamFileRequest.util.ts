import type {
  FileRequestFolder,
  TeamFileRequest,
} from "../services/teamFileRequest.service";

export function fileRequestFolderLabel(
  folder: FileRequestFolder,
  folders: FileRequestFolder[],
): string {
  const names = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = folders.find((f) => f.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}

/** Check the URL against the destination returned by the server. */
export function canUploadToFileRequest(
  request: TeamFileRequest | undefined,
  teamId: string | undefined,
  folderId: string | undefined,
): boolean {
  return (
    !!request?.canRespond &&
    request.teamId === teamId &&
    request.folderId === folderId &&
    request.status === "OPEN" &&
    new Date(request.expiresAt).getTime() > Date.now()
  );
}

export const isSafeFileRequestNotificationAction = (
  value: unknown,
): value is string =>
  typeof value === "string" &&
  /^\/team\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?fileRequests=1$/i.test(
    value,
  );
