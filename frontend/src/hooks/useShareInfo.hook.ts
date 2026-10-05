import { useEffect, useState } from "react";
import { openShareInfo, ShareInfo } from "../utils/fileMetadata.util";

type ShareRow = {
  id: string;
  name?: string | null;
  description?: string | null;
  encryptedInfo?: string | null;
};

/**
 * Title and description of a share (FILE_META_V1 share info).
 *
 * Readable titles are returned as they are. An encrypted one is opened with
 * the share key once it is known: `pending` stays true until then, and
 * `infoUnreadable` is set when the key cannot open it.
 */
export default function useShareInfo(
  share: ShareRow | undefined,
  key: string | null,
): ShareInfo & { pending: boolean; infoUnreadable?: boolean } {
  const encryptedInfo = share?.encryptedInfo ?? null;
  const [opened, setOpened] = useState<{
    source: string;
    key: string;
    info: ShareInfo & { infoUnreadable?: boolean };
  } | null>(null);

  useEffect(() => {
    if (!share || !encryptedInfo || !key) return;
    let cancelled = false;
    void openShareInfo(share, key).then((info) => {
      if (!cancelled) setOpened({ source: encryptedInfo, key, info });
    });
    return () => {
      cancelled = true;
    };
  }, [share, encryptedInfo, key]);

  if (!share) return { pending: true };
  if (!encryptedInfo) {
    return {
      ...(share.name && { name: share.name }),
      ...(share.description && { description: share.description }),
      pending: false,
    };
  }
  if (opened && opened.source === encryptedInfo && opened.key === key) {
    return { ...opened.info, pending: false };
  }
  return { pending: true };
}
