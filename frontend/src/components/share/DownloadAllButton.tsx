import { Button } from "@mantine/core";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import toast from "../../utils/toast.util";
import { FileMetaData } from "../../types/File.type";

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
  const t = useTranslate();

  const downloadAllE2E = async () => {
    if (!e2eKey || !files) return;
    setIsLoading(true);
    try {
      for (const file of files) {
        await shareService.downloadFileE2E(shareId, file.id, file.name, e2eKey);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const downloadAll = async () => {
    setIsLoading(true);
    await shareService
      .downloadFile(shareId, "zip")
      .then(() => setIsLoading(false));
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
    <Button
      variant="outline"
      loading={isLoading}
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
  );
};

export default DownloadAllButton;
