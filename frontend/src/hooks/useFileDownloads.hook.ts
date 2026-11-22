import { useCallback, useRef, useState } from "react";
import shareService from "../services/share.service";
import { downloadErrorKey } from "../utils/downloadError.util";
import toast from "../utils/toast.util";
import useTranslate from "./useTranslate.hook";

type DownloadableFile = {
  id: string;
  shareId: string;
  name: string;
  isE2EEncrypted: boolean;
};

/**
 * Single file downloads with their progress in percent, keyed by file id.
 * E2E files are decrypted with `encodedKey` and wait until it is known.
 */
export default function useFileDownloads(encodedKey: string | null) {
  const t = useTranslate();
  const [progress, setProgress] = useState<Record<string, number>>({});
  const controllers = useRef(new Map<string, AbortController>());

  const setFileProgress = (fileId: string, value: number | null) =>
    setProgress((previous) => {
      const next = { ...previous };
      if (value === null) delete next[fileId];
      else next[fileId] = value;
      return next;
    });

  const start = useCallback(
    async (file: DownloadableFile) => {
      if (controllers.current.has(file.id)) return;
      if (file.isE2EEncrypted && !encodedKey) return;
      const controller = new AbortController();
      controllers.current.set(file.id, controller);
      setFileProgress(file.id, 0);
      const onProgress = (downloaded: number, total: number) => {
        if (total > 0)
          setFileProgress(file.id, Math.min(100, (downloaded / total) * 100));
      };
      try {
        if (file.isE2EEncrypted && encodedKey) {
          await shareService.downloadFileE2E(
            file.shareId,
            file.id,
            file.name,
            encodedKey,
            onProgress,
            controller.signal,
          );
        } else {
          await shareService.downloadFileWithProgress(
            file.shareId,
            file.id,
            file.name,
            onProgress,
            controller.signal,
          );
        }
      } catch (error) {
        const message = downloadErrorKey(error);
        if (message) toast.error(t(message));
      } finally {
        controllers.current.delete(file.id);
        setFileProgress(file.id, null);
      }
    },
    [encodedKey, t],
  );

  const cancel = useCallback((fileId: string) => {
    controllers.current.get(fileId)?.abort();
  }, []);

  return { progress, start, cancel };
}
