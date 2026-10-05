import { useEffect, useState } from "react";
import { openSharesWithKey } from "../utils/fileMetadata.util";

type FileRow = {
  id: string;
  name: string;
  relativePath?: string | null;
  metadataScheme?: number | null;
  encryptedMetadata?: string | null;
};

type ShareRow = {
  id: string;
  name?: string | null;
  description?: string | null;
  encryptedInfo?: string | null;
  files: FileRow[];
};

/**
 * Shares under one key (a Team folder and K_team) with their encrypted file
 * names, titles and descriptions opened (FILE_META_V1).
 *
 * Lists without encrypted names are returned as they are. Otherwise the
 * server rows, carrying placeholders, are returned until the key is known
 * and the names are open, and `pending` stays true meanwhile.
 */
export default function useOpenedShares<S extends ShareRow>(
  shares: S[] | undefined,
  key: string | null,
): { shares: S[] | undefined; pending: boolean } {
  const encrypted = !!shares?.some(
    (share) =>
      !!share.encryptedInfo ||
      share.files.some((file) => file.metadataScheme != null),
  );
  const [opened, setOpened] = useState<{
    source: S[];
    key: string;
    shares: S[];
  } | null>(null);

  useEffect(() => {
    if (!encrypted || !shares || !key) return;
    let cancelled = false;
    void openSharesWithKey(shares, key).then((result) => {
      if (!cancelled) setOpened({ source: shares, key, shares: result });
    });
    return () => {
      cancelled = true;
    };
  }, [encrypted, shares, key]);

  if (!encrypted) return { shares, pending: false };
  if (opened && opened.source === shares && opened.key === key) {
    return { shares: opened.shares, pending: false };
  }
  return { shares, pending: true };
}
