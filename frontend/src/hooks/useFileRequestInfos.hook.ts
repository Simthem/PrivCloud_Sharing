import { useEffect, useState } from "react";
import {
  FileRequestInfo,
  openFileRequestInfo,
} from "../utils/fileMetadata.util";

type RequestRow = {
  id: string;
  subject: string;
  note?: string | null;
  encryptedInfo?: string | null;
};

export default function useFileRequestInfos(
  requests: RequestRow[] | undefined,
  teamKey: string | null,
): Record<string, FileRequestInfo | undefined> {
  const [opened, setOpened] = useState<{
    source: RequestRow[];
    key: string;
    infos: Record<string, FileRequestInfo | undefined>;
  } | null>(null);
  useEffect(() => {
    if (!requests || !teamKey) return;
    let cancelled = false;
    void Promise.all(
      requests
        .filter((r) => r.encryptedInfo)
        .map(
          async (request) =>
            [request.id, await openFileRequestInfo(request, teamKey)] as const,
        ),
    ).then((entries) => {
      if (!cancelled)
        setOpened({
          source: requests,
          key: teamKey,
          infos: Object.fromEntries(entries),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [requests, teamKey]);
  const infos: Record<string, FileRequestInfo | undefined> = {};
  for (const request of requests || []) {
    infos[request.id] = request.encryptedInfo
      ? opened && opened.source === requests && opened.key === teamKey
        ? opened.infos[request.id]
        : undefined
      : {
          subject: request.subject,
          ...(request.note && { note: request.note }),
        };
  }
  return infos;
}
