import { fromEvent } from "file-selector";
import type { DropEvent } from "react-dropzone";
import { attachUploadRelativePath } from "./uploadPath.util";

type UploadPathFile = File & {
  uploadRelativePath?: string;
};

type LegacyFileSystemEntry = {
  name: string;
  fullPath?: string;
  isFile: boolean;
  isDirectory: boolean;
};

type LegacyFileSystemFileEntry = LegacyFileSystemEntry & {
  isFile: true;
  file: (
    _successCallback: (_file: File) => void,
    _errorCallback?: (_error: DOMException) => void,
  ) => void;
};

type LegacyFileSystemDirectoryEntry = LegacyFileSystemEntry & {
  isDirectory: true;
  createReader: () => LegacyFileSystemDirectoryReader;
};

type LegacyFileSystemDirectoryReader = {
  readEntries: (
    _successCallback: (_entries: LegacyFileSystemEntry[]) => void,
    _errorCallback?: (_error: DOMException) => void,
  ) => void;
};

type LegacyDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
};

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

const isFileEntry = (
  entry: LegacyFileSystemEntry,
): entry is LegacyFileSystemFileEntry =>
  entry.isFile && typeof (entry as LegacyFileSystemFileEntry).file === "function";

const isDirectoryEntry = (
  entry: LegacyFileSystemEntry,
): entry is LegacyFileSystemDirectoryEntry =>
  entry.isDirectory &&
  typeof (entry as LegacyFileSystemDirectoryEntry).createReader === "function";

const isFileLike = (value: File | DataTransferItem): value is File =>
  typeof (value as File).name === "string" &&
  typeof (value as File).size === "number";

const readDirectoryBatch = (
  reader: LegacyFileSystemDirectoryReader,
): Promise<LegacyFileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });

const readAllDirectoryEntries = async (
  reader: LegacyFileSystemDirectoryReader,
): Promise<LegacyFileSystemEntry[]> => {
  const entries: LegacyFileSystemEntry[] = [];

  while (true) {
    const batch = await readDirectoryBatch(reader);
    if (batch.length === 0) break;
    entries.push(...batch);
  }

  return entries;
};

const readFileEntry = (
  entry: LegacyFileSystemFileEntry,
): Promise<UploadPathFile> =>
  new Promise((resolve, reject) => {
    entry.file((file) => resolve(attachUploadRelativePath(file, entry.fullPath)), reject);
  });

const readEntry = async (
  entry: LegacyFileSystemEntry,
): Promise<UploadPathFile[]> => {
  if (isFileEntry(entry)) {
    return [await readFileEntry(entry)];
  }

  if (!isDirectoryEntry(entry)) {
    return [];
  }

  const entries = await readAllDirectoryEntries(entry.createReader());
  const files = await Promise.all(entries.map(readEntry));
  return files.flat();
};

const getDataTransferEntries = (
  event: DropEvent,
): LegacyFileSystemEntry[] | undefined => {
  const dataTransfer = (event as { dataTransfer?: DataTransfer }).dataTransfer;
  if (!dataTransfer?.items?.length) return undefined;

  const entries = Array.from(dataTransfer.items)
    .filter(
      (item) =>
        item.kind === "file" &&
        typeof (item as LegacyDataTransferItem).webkitGetAsEntry === "function",
    )
    .map(
      (item) =>
        (item as LegacyDataTransferItem).webkitGetAsEntry?.() as
          | LegacyFileSystemEntry
          | null
          | undefined,
    )
    .filter((entry): entry is LegacyFileSystemEntry => !!entry);

  return entries.length > 0 ? entries : undefined;
};

const getFilesFromDataTransferEntries = async (
  event: DropEvent,
): Promise<UploadPathFile[] | undefined> => {
  const entries = getDataTransferEntries(event);
  if (!entries) return undefined;

  const files = await Promise.all(entries.map(readEntry));
  return files.flat().filter((file) => !IGNORED_FILE_NAMES.has(file.name));
};

export const getFilesFromDropEvent = async (
  event: DropEvent,
): Promise<Array<File | DataTransferItem>> => {
  const isDrop = (event as { type?: string }).type === "drop";
  const entryFiles = isDrop
    ? await getFilesFromDataTransferEntries(event)
    : undefined;

  if (entryFiles) return entryFiles;

  const files = await fromEvent(event);
  return files.map((file) =>
    isFileLike(file) ? attachUploadRelativePath(file) : file,
  );
};
