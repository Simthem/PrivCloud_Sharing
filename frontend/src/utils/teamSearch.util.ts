export type TeamSearchKind = "FILE" | "FOLDER" | "SIGNATURE" | "ACTIVITY";

export type TeamSearchResult = {
  id: string;
  kind: TeamSearchKind;
  name: string;
  secondary: string;
  folderId?: string | null;
  fileId?: string | null;
  shareId?: string | null;
  status?: string | null;
  extension?: string | null;
  author?: string | null;
  createdAt: string;
  isE2EEncrypted?: boolean;
};

export type TeamSearchFilters = {
  query?: string;
  kind?: TeamSearchKind | "ALL";
  folderId?: string;
  author?: string;
  extension?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

type SearchIndexLike = {
  folders: Array<{
    id: string;
    name: string;
    description?: string | null;
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
    createdAt: string;
    author?: { username: string; email: string } | null;
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
  activity: Array<{
    id: string;
    action: string;
    actorEmail: string;
    actorName?: string;
    fileName?: string;
    folder?: { name: string };
    createdAt: string;
  }>;
};

const normalize = (value: string | null | undefined) =>
  (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();

const extensionOf = (name: string) => {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1]?.toLocaleLowerCase() || null;
};

export function buildTeamSearchResults(
  index: SearchIndexLike,
  filters: TeamSearchFilters,
): TeamSearchResult[] {
  const results: TeamSearchResult[] = [
    ...index.files.map((file) => ({
      id: file.id,
      kind: "FILE" as const,
      name: file.relativePath || file.name,
      secondary: [file.folderName, file.author?.username || file.author?.email]
        .filter(Boolean)
        .join(" · "),
      folderId: file.folderId,
      fileId: file.id,
      shareId: file.shareId,
      status: file.signature?.status || null,
      extension: extensionOf(file.name),
      author: file.author?.email || null,
      createdAt: file.createdAt,
      isE2EEncrypted: file.isE2EEncrypted,
    })),
    ...index.folders.map((folder) => ({
      id: folder.id,
      kind: "FOLDER" as const,
      name: folder.name,
      secondary: folder.description || "",
      folderId: folder.id,
      createdAt: folder.createdAt,
    })),
    ...index.signatures.map((signature) => ({
      id: signature.id,
      kind: "SIGNATURE" as const,
      name: signature.name,
      secondary: signature.author?.username || signature.author?.email || "",
      fileId: signature.fileId,
      status: signature.status,
      author: signature.author?.email || null,
      createdAt: signature.createdAt,
    })),
    ...index.activity.map((event) => ({
      id: event.id,
      kind: "ACTIVITY" as const,
      name: event.fileName || event.folder?.name || event.action,
      secondary: `${event.action} · ${event.actorName || event.actorEmail}`,
      author: event.actorEmail,
      createdAt: event.createdAt,
    })),
  ];

  const query = normalize(filters.query);
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : null;

  return results
    .filter((result) => !filters.kind || filters.kind === "ALL" || result.kind === filters.kind)
    .filter((result) => !filters.folderId || result.folderId === filters.folderId)
    .filter((result) => !filters.author || result.author === filters.author)
    .filter((result) => !filters.extension || result.extension === filters.extension)
    .filter((result) => !filters.status || result.status === filters.status)
    .filter((result) => {
      const timestamp = new Date(result.createdAt).getTime();
      return (from == null || timestamp >= from) && (to == null || timestamp <= to);
    })
    .filter((result) => {
      if (!query) return true;
      return normalize(`${result.name} ${result.secondary} ${result.status || ""}`).includes(query);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
