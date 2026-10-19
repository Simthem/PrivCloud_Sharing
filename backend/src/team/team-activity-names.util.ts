import {
  encryptedFilePlaceholderName,
  FILE_META_V1,
  isValidEncryptedMetadata,
} from "../file/file-metadata-scheme";

/**
 * FILE_META_V1 for team activity. Upload and download events record the
 * names the server knows, which for an encrypted file is its placeholder
 * ("encrypted-file-" and the first 8 characters of its id). An upload of
 * several files records their names joined by ", ".
 *
 * The server cannot read those names. It attaches each placeholder's
 * encrypted name to the event instead, and a member holding K_team opens it in
 * the browser, as the search does for the files themselves. The encrypted
 * names are also stored in the event when it is logged, so that they outlive
 * the files: events logged before that only find the files that still exist.
 */

export type ActivityEncryptedFile = {
  fileId: string;
  shareId: string;
  name: string;
  metadataScheme: number;
  encryptedMetadata: string;
};

type ActivityLogLike = {
  action: string;
  fileName: string | null;
  folderId: string | null;
  fileSize?: bigint | number | null;
  metadata?: string | null;
};

type FolderFile = ActivityEncryptedFile & { folderId: string };

type LoggedFile = {
  id: string;
  shareId: string;
  metadataScheme: number | null;
  encryptedMetadata: string | null;
};

const PLACEHOLDER_PREFIX = encryptedFilePlaceholderName("");

export const ACTIVITY_NAME_SEPARATOR = ", ";

/** Placeholders named by an event, in order and without repeats. */
export function activityPlaceholders(fileName: string | null): string[] {
  if (!fileName) return [];
  return [
    ...new Set(
      fileName
        .split(ACTIVITY_NAME_SEPARATOR)
        .filter(
          (part) =>
            part.length === PLACEHOLDER_PREFIX.length + 8 &&
            part.startsWith(PLACEHOLDER_PREFIX),
        ),
    ),
  ];
}

/** Id prefixes to look the placeholders of these events up by. */
export function activityIdPrefixes(logs: ActivityLogLike[]): string[] {
  return [
    ...new Set(
      logs.flatMap((log) =>
        log.folderId
          ? activityPlaceholders(log.fileName).map((placeholder) =>
              placeholder.slice(PLACEHOLDER_PREFIX.length),
            )
          : [],
      ),
    ),
  ];
}

/**
 * Event metadata keeping the encrypted names of the logged files, or
 * undefined when none of them is encrypted. Opaque to the server, and no key
 * material: only K_team opens them.
 */
export function activityNameMetadata(
  files: LoggedFile[],
): { encryptedFiles: Omit<ActivityEncryptedFile, "name">[] } | undefined {
  const encryptedFiles = files
    .filter(
      (file) =>
        file.metadataScheme === FILE_META_V1 && !!file.encryptedMetadata,
    )
    .map((file) => ({
      fileId: file.id,
      shareId: file.shareId,
      metadataScheme: FILE_META_V1,
      encryptedMetadata: file.encryptedMetadata as string,
    }));
  return encryptedFiles.length > 0 ? { encryptedFiles } : undefined;
}

/** The same, serialized for `TeamAccessLog.metadata`. */
export function serializeActivityNames(
  files: LoggedFile[],
): string | undefined {
  const metadata = activityNameMetadata(files);
  return metadata ? JSON.stringify(metadata) : undefined;
}

const isLoggedEntry = (
  value: unknown,
): value is Omit<ActivityEncryptedFile, "name"> => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fileId === "string" &&
    typeof entry.shareId === "string" &&
    entry.metadataScheme === FILE_META_V1 &&
    isValidEncryptedMetadata(entry.encryptedMetadata)
  );
};

/** The stored entries of an event's metadata, in order, or none. */
function storedEntries(
  metadata: string | null | undefined,
): Omit<ActivityEncryptedFile, "name">[] {
  if (!metadata) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return [];
  }
  const entries = (parsed as { encryptedFiles?: unknown } | null)
    ?.encryptedFiles;
  return Array.isArray(entries) ? entries.filter(isLoggedEntry) : [];
}

/** Encrypted names stored in an event's metadata, keyed by placeholder. */
export function storedActivityFiles(
  metadata: string | null | undefined,
): Map<string, ActivityEncryptedFile> {
  const stored = new Map<string, ActivityEncryptedFile>();
  for (const entry of storedEntries(metadata)) {
    const name = encryptedFilePlaceholderName(entry.fileId);
    stored.set(name, { ...entry, name });
  }
  return stored;
}

/**
 * Each event with the encrypted names of the placeholders it names. A file
 * that still exists in the event's folder gives its current encrypted name,
 * which follows K_team rotations. Otherwise the name stored in the event when
 * it was logged is used: it stays under the K_team of that time, so it no
 * longer opens after a rotation. A placeholder found in neither stays as it
 * is.
 */
export function attachActivityEncryptedFiles<T extends ActivityLogLike>(
  logs: T[],
  files: FolderFile[],
): Array<T & { encryptedFiles?: ActivityEncryptedFile[] }> {
  const byPlaceholder = new Map<string, ActivityEncryptedFile>();
  for (const { folderId, ...file } of files) {
    byPlaceholder.set(
      `${folderId}\n${encryptedFilePlaceholderName(file.fileId)}`,
      file,
    );
  }
  return logs.map((log) => {
    const stored = storedActivityFiles(log.metadata);
    const encryptedFiles = activityPlaceholders(log.fileName)
      .map(
        (placeholder) =>
          (log.folderId
            ? byPlaceholder.get(`${log.folderId}\n${placeholder}`)
            : undefined) ?? stored.get(placeholder),
      )
      .filter((file): file is ActivityEncryptedFile => !!file);
    return encryptedFiles.length > 0 ? { ...log, encryptedFiles } : log;
  });
}

/**
 * Until this fix, a team upload was logged twice: once when its share was
 * created, under the share id and without a size, and once when it completed,
 * under its file names and with their total size. The first entry is a
 * duplicate, hidden from the activity. Only those entries are uploads without
 * a size, so they are recognized even once their share is gone.
 */
export function isCreationUploadDuplicate(log: {
  action: string;
  fileSize?: bigint | number | null;
}): boolean {
  return log.action === "UPLOAD" && log.fileSize == null;
}

// ----- K_team rotation -----------------------------------------------------
//
// The stored names are under the K_team of the time they were logged, so a
// rotation re-encrypts them like every other team ciphertext: the client
// stages one replacement per stored name, and the rotation only completes
// once each current name has one.

export type ActivityRotationRow = {
  /** `<event id>:<file id>`, the staging id. */
  id: string;
  shareId: string;
  fileId: string;
  encryptedInfo: string;
};

export const ACTIVITY_ROTATION_ID_SEPARATOR = ":";

export function activityRotationId(logId: string, fileId: string): string {
  return `${logId}${ACTIVITY_ROTATION_ID_SEPARATOR}${fileId}`;
}

/** Every stored name of these events, as rotation metadata. */
export function activityRotationRows(
  logs: { id: string; metadata: string | null }[],
): ActivityRotationRow[] {
  return logs.flatMap((log) =>
    storedEntries(log.metadata).map((entry) => ({
      id: activityRotationId(log.id, entry.fileId),
      shareId: entry.shareId,
      fileId: entry.fileId,
      encryptedInfo: entry.encryptedMetadata,
    })),
  );
}

/**
 * An event's metadata with its stored names replaced, by file id, with their
 * rotated values. An empty replacement drops the name: a client stages it for
 * a name that opens with neither key, which nobody can read anyway and which
 * must not block every later rotation. Other metadata keys are kept.
 */
export function rotateActivityMetadata(
  metadata: string,
  replacements: Map<string, string>,
): string {
  const parsed: unknown = JSON.parse(metadata);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return metadata;
  }
  const encryptedFiles = storedEntries(metadata).flatMap((entry) => {
    const replacement = replacements.get(entry.fileId);
    if (replacement === undefined) return [entry];
    return replacement ? [{ ...entry, encryptedMetadata: replacement }] : [];
  });
  const { encryptedFiles: _previous, ...rest } = parsed as Record<
    string,
    unknown
  >;
  return JSON.stringify(
    encryptedFiles.length > 0 ? { ...rest, encryptedFiles } : rest,
  );
}
