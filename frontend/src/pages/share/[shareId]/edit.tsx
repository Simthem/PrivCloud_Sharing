import { LoadingOverlay } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { GetServerSidePropsContext } from "next";
import { useEffect, useState } from "react";
import Meta from "../../../components/Meta";
import showErrorModal from "../../../components/share/showErrorModal";
import EditableUpload from "../../../components/upload/EditableUpload";
import useConfirmLeave from "../../../hooks/confirm-leave.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import useDecryptedFileNames from "../../../hooks/useDecryptedFileNames.hook";
import shareService from "../../../services/share.service";
import { Share as ShareType } from "../../../types/share.type";
import { FileMetaData } from "../../../types/File.type";
import { getUserKey } from "../../../utils/crypto.util";
import { isFileMetaShare } from "../../../utils/fileMetadata.util";
import { reportShareCryptoEvent } from "../../../utils/shareCryptoEvents.util";
import {
  SHARE_DEK_V1,
  resolveOwnerShareKey,
} from "../../../utils/shareKey.util";
import { useQuery } from "@tanstack/react-query";
import { AxiosError } from "axios";

export function getServerSideProps(context: GetServerSidePropsContext) {
  return {
    props: { shareId: context.params!.shareId },
  };
}

const Share = ({ shareId }: { shareId: string }) => {
  const t = useTranslate();
  const modals = useModals();

  const {
    data: share,
    error,
    isLoading,
  } = useQuery<ShareType>({
    queryKey: ["share", shareId],
    retry: false,
    queryFn: () => shareService.getFromOwner(shareId),
  });

  // FILE_META_V1: the file list shows the real names, opened with K_share.
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [ownerKeyResolved, setOwnerKeyResolved] = useState(false);
  useEffect(() => {
    if (!share) return;
    const userKey = getUserKey();
    if (!isFileMetaShare(share) || !userKey) {
      setOwnerKeyResolved(true);
      return;
    }
    let cancelled = false;
    shareService
      .getShareKeyMaterial(shareId)
      .then((material) => resolveOwnerShareKey(shareId, userKey, material))
      .then((key) => {
        if (!cancelled) setOwnerKey(key);
      })
      .catch(() => reportShareCryptoEvent("unwrap_error", SHARE_DEK_V1))
      .finally(() => {
        if (!cancelled) setOwnerKeyResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [share, shareId]);
  const { files, pending: fileNamesPending } =
    useDecryptedFileNames<FileMetaData>(share?.id, share?.files, ownerKey);

  useConfirmLeave({
    message: t("upload.notify.confirm-leave"),
    enabled: isLoading,
  });

  useEffect(() => {
    if (!(error instanceof AxiosError) || !error.response) {
      return;
    }

    const { data: errorData, status: errorStatus } = error.response;
    if (errorStatus == 404) {
      if (errorData.error == "share_removed") {
        showErrorModal(
          modals,
          t("share.error.removed.title"),
          errorData.message,
        );
      } else {
        showErrorModal(
          modals,
          t("share.error.not-found.title"),
          t("share.error.not-found.description"),
        );
      }
    } else if (errorStatus == 403) {
      showErrorModal(
        modals,
        t("share.error.access-denied.title"),
        t("share.error.access-denied.description"),
      );
    } else {
      showErrorModal(modals, t("common.error"), t("common.error.unknown"));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  if (
    isLoading ||
    (share && !ownerKeyResolved) ||
    (!!ownerKey && fileNamesPending)
  ) {
    return <LoadingOverlay visible />;
  }

  return (
    <>
      <Meta title={t("share.edit.title", { shareId })} noIndex />
      <EditableUpload
        shareId={shareId}
        files={files || []}
        isE2EEncrypted={share?.isE2EEncrypted}
        cryptoScheme={share?.cryptoScheme}
        fileMetadataScheme={share?.fileMetadataScheme}
      />
    </>
  );
};

export default Share;
