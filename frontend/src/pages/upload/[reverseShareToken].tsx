import { LoadingOverlay } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { GetServerSidePropsContext } from "next";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Upload from ".";
import showErrorModal from "../../components/share/showErrorModal";
import shareService from "../../services/share.service";
import useTranslate from "../../hooks/useTranslate.hook";
import { ReverseShare } from "../../types/share.type";
import { AxiosError } from "axios";
import { extractKeyFromHash } from "../../utils/crypto.util";
import { openReverseShareName } from "../../utils/fileMetadata.util";

export function getServerSideProps(context: GetServerSidePropsContext) {
  return {
    props: { reverseShareToken: context.params!.reverseShareToken },
  };
}

const Share = ({ reverseShareToken }: { reverseShareToken: string }) => {
  const modals = useModals();
  const t = useTranslate();

  const {
    data: reverseShare,
    isLoading,
    error,
  } = useQuery<ReverseShare>({
    queryKey: ["reverseShare", reverseShareToken],
    queryFn: () => shareService.getReverseShare(reverseShareToken),
    retry: false,
  });

  // The name of an E2E link may be encrypted with its K_rs, which only the
  // holders of the link have, in the URL fragment.
  const [openedName, setOpenedName] = useState<string>();
  useEffect(() => {
    if (!reverseShare?.encryptedName) return;
    let cancelled = false;
    void openReverseShareName(reverseShare, extractKeyFromHash()).then(
      (name) => {
        if (!cancelled) setOpenedName(name);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reverseShare]);

  useEffect(() => {
    if (!(error instanceof AxiosError) || !error.response) {
      return;
    }

    if (error.response.status == 404) {
      showErrorModal(
        modals,
        t("upload.reverse-share.error.invalid.title"),
        t("upload.reverse-share.error.invalid.description"),
        "go-home",
      );
    } else {
      showErrorModal(modals, t("common.error"), t("common.error.unknown"));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  if (isLoading) return <LoadingOverlay visible />;

  const parsedMaxShareSize =
    (reverseShare?.effectiveMaxShareSize || reverseShare?.maxShareSize)
      ? parseInt(reverseShare.effectiveMaxShareSize || reverseShare.maxShareSize, 10)
      : undefined;

  return (
    <Upload
      isReverseShare
      isE2EEncrypted={reverseShare?.isE2EEncrypted || false}
      fileMetaV1Write={reverseShare?.fileMetaV1Write || false}
      name={reverseShare?.encryptedName ? openedName : reverseShare?.name}
      maxShareSize={parsedMaxShareSize}
      simplified={reverseShare?.simplified || false}
    />
  );
};

export default Share;
