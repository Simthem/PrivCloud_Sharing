import { Button, Group } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import toast from "../../utils/toast.util";
import { FileMetaData } from "../../types/File.type";
import DownloadProgressIndicator from "./DownloadProgressIndicator";

const DownloadAllButton = ({
  shareId,
  isE2EEncrypted,
  e2eKey,
  files,
}: {
  shareId: string;
  isE2EEncrypted?: boolean;
  e2eKey?: string | null;
  files?: FileMetaData[];
}) => {
  const [isZipReady, setIsZipReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const t = useTranslate();

  const downloadAllE2E = async () => {
    if (!e2eKey || !files) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setProgress(0);
    try {
      await shareService.downloadAllAsZipE2E(
        shareId,
        files,
        e2eKey,
        (done, total) => {
          setProgress(total > 0 ? (done / total) * 100 : 0);
        },
        controller.signal,
      );
    } catch (e: any) {
      if (e.name !== "AbortError") {
        toast.error(t("common.error"));
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
      setProgress(null);
    }
  };

  const downloadAll = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setProgress(0);
    try {
      await shareService.downloadAllAsZip(
        shareId,
        (downloaded, total) => {
          setProgress(total > 0 ? (downloaded / total) * 100 : 0);
        },
        controller.signal,
      );
    } catch (e: any) {
      if (e.name !== "AbortError") {
        toast.error(t("common.error"));
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
      setProgress(null);
    }
  };

  useEffect(() => {
    // Pour les partages E2E, pas de ZIP côté serveur
    if (isE2EEncrypted) {
      setIsZipReady(true);
      return;
    }

    shareService
      .getMetaData(shareId)
      .then((share) => setIsZipReady(share.isZipReady))
      .catch(() => {});

    const timer = setInterval(() => {
      shareService
        .getMetaData(shareId)
        .then((share) => {
          setIsZipReady(share.isZipReady);
          if (share.isZipReady) clearInterval(timer);
        })
        .catch(() => clearInterval(timer));
    }, 5000);
    return () => {
      clearInterval(timer);
    };
  }, [isE2EEncrypted]);

  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        variant="outline"
        loading={isLoading}
        disabled={isLoading}
        onClick={() => {
          if (!isZipReady) {
            toast.error(t("share.notify.download-all-preparing"));
          } else if (isE2EEncrypted && e2eKey) {
            downloadAllE2E();
          } else {
            downloadAll();
          }
        }}
      >
        <FormattedMessage id="share.button.download-all" />
      </Button>
      {isLoading && progress !== null && (
        <DownloadProgressIndicator
          progress={progress}
          onCancel={() => abortRef.current?.abort()}
        />
      )}
    </Group>
  );
};

export default DownloadAllButton;
