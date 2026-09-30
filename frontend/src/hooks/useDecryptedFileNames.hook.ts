import { useEffect, useState } from "react";
import { decryptShareFileNames } from "../utils/fileMetadata.util";

type FileRow = {
  id: string;
  name: string;
  relativePath?: string | null;
  metadataScheme?: number | null;
  encryptedMetadata?: string | null;
  metadataUnreadable?: boolean;
};

/**
 * Files of a share with their real names (FILE_META_V1).
 *
 * Shares without encrypted names are returned as they are. Otherwise the
 * names are opened with the share key once it is known: `pending` stays true
 * until then, while the files still carry the server placeholder.
 */
export default function useDecryptedFileNames<T extends FileRow>(
  shareId: string | undefined,
  files: T[] | undefined,
  key: string | null,
): { files: T[] | undefined; pending: boolean } {
  const encrypted = !!files?.some((file) => file.metadataScheme != null);
  const [decrypted, setDecrypted] = useState<{
    source: T[];
    key: string;
    files: T[];
  } | null>(null);

  useEffect(() => {
    if (!encrypted || !files || !shareId || !key) return;
    let cancelled = false;
    void decryptShareFileNames(shareId, files, key).then((result) => {
      if (!cancelled) setDecrypted({ source: files, key, files: result });
    });
    return () => {
      cancelled = true;
    };
  }, [encrypted, files, shareId, key]);

  if (!encrypted) return { files, pending: false };
  if (decrypted && decrypted.source === files && decrypted.key === key) {
    return { files: decrypted.files, pending: false };
  }
  return { files, pending: true };
}
