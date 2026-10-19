import { openFileName } from "./fileMetadata.util";

/**
 * FILE_META_V1 for team activity. The server records the placeholder of an
 * encrypted file in upload and download events, several of them joined by
 * ", " for a multi-file upload, and sends each one's encrypted name next to
 * the event. They are opened here with K_team. A name that cannot be opened
 * keeps its placeholder.
 */

export type ActivityEncryptedFile = {
  fileId: string;
  shareId: string;
  name: string;
  metadataScheme: number;
  encryptedMetadata: string;
};

const SEPARATOR = ", ";

type ActivityLike = {
  fileName?: string | null;
  encryptedFiles?: ActivityEncryptedFile[];
};

export async function openActivityNames<T extends ActivityLike>(
  logs: T[],
  key: CryptoKey,
): Promise<T[]> {
  return Promise.all(
    logs.map(async (log) => {
      if (!log.fileName || !log.encryptedFiles?.length) return log;
      const names = new Map(
        await Promise.all(
          log.encryptedFiles.map(
            async (file) =>
              [file.name, (await openFileName(file, key)).name] as const,
          ),
        ),
      );
      return {
        ...log,
        fileName: log.fileName
          .split(SEPARATOR)
          .map((part) => names.get(part) ?? part)
          .join(SEPARATOR),
      };
    }),
  );
}
