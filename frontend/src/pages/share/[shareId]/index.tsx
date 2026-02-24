import { Alert, Box, Group, Text, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { GetServerSidePropsContext } from "next";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { TbLock } from "react-icons/tb";
import Meta from "../../../components/Meta";
import DownloadAllButton from "../../../components/share/DownloadAllButton";
import FileList from "../../../components/share/FileList";
import showEnterPasswordModal from "../../../components/share/showEnterPasswordModal";
import showErrorModal from "../../../components/share/showErrorModal";
import useTranslate from "../../../hooks/useTranslate.hook";
import shareService from "../../../services/share.service";
import { Share as ShareType } from "../../../types/share.type";
import toast from "../../../utils/toast.util";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";
import { extractKeyFromHash, getUserKey } from "../../../utils/crypto.util";
import { AxiosError } from "axios";

export function getServerSideProps(context: GetServerSidePropsContext) {
  return {
    props: { shareId: context.params!.shareId },
  };
}

const Share = ({ shareId }: { shareId: string }) => {
  const modals = useModals();
  const { data: share, error, refetch, isLoading } = useQuery<ShareType>({
    queryKey: ["share", shareId],
    retry: false,
    queryFn: () => shareService.get(shareId)
  });

  const t = useTranslate();

  // ── E2E : récupérer la clé depuis le fragment d'URL ou localStorage utilisateur ──
  const [e2eKey, setE2eKey] = useState<string | null>(null);
  useEffect(() => {
    const hashKey = extractKeyFromHash();
    const userKey = getUserKey();
    setE2eKey(hashKey || userKey || null);
  }, [shareId]);

  const isE2EMissingKey = share?.isE2EEncrypted && !e2eKey;

  const getShareToken = async (password?: string) => {
    await shareService
      .getShareToken(shareId, password)
      .then(() => {
        modals.closeAll();
        refetch();
      })
      .catch((e) => {
        const { error } = e.response.data;
        if (error == "share_max_views_exceeded") {
          showErrorModal(
            modals,
            t("share.error.visitor-limit-exceeded.title"),
            t("share.error.visitor-limit-exceeded.description"),
            "go-home",
          );
        } else if (error == "share_password_required") {
          showEnterPasswordModal(modals, getShareToken);
        } else {
          toast.axiosError(e);
        }
      });
  };

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
          "go-home",
        );
      } else {
        showErrorModal(
          modals,
          t("share.error.not-found.title"),
          t("share.error.not-found.description"),
          "go-home",
        );
      }
    } else if (errorData.error == "share_password_required") {
      showEnterPasswordModal(modals, getShareToken);
    } else if (errorData.error == "private_share") {
      showErrorModal(
        modals,
        t("share.error.access-denied.title"),
        t("share.error.access-denied.description"),
        "go-home",
      );
    } else if (errorData.error == "share_token_required") {
      getShareToken();
    } else {
      showErrorModal(
        modals,
        t("common.error"),
        t("common.error.unknown"),
        "go-home",
      );
    }
  }, [error])

  return (
    <>
      <Meta
        title={t("share.title", { shareId: share?.name || shareId })}
        description={t("share.description")}
      />

      <Group position="apart" mb="lg">
        <Box style={{ maxWidth: "70%" }}>
          <Title order={3}>{share?.name || share?.id}</Title>
          <Text size="sm">{share?.description}</Text>
          {share?.files?.length > 0 && (
            <Text size="sm" color="dimmed" mt={5}>
              <FormattedMessage
                id="share.fileCount"
                values={{
                  count: share?.files?.length || 0,
                  size: byteToHumanSizeString(
                    share?.files?.reduce(
                      (total: number, file: { size: string }) =>
                        total + parseInt(file.size),
                      0,
                    ) || 0,
                  ),
                }}
              />
            </Text>
          )}
        </Box>

        {share?.files.length > 1 && !isE2EMissingKey && (
          <DownloadAllButton shareId={shareId} isE2EEncrypted={share?.isE2EEncrypted} e2eKey={e2eKey} files={share?.files} />
        )}
      </Group>

      {isE2EMissingKey && (
        <Alert icon={<TbLock size={16} />} title="Chiffrement de bout en bout" color="red" mb="lg">
          Ce partage est chiffré de bout en bout. La clé de déchiffrement est manquante dans l'URL.
          Veuillez utiliser le lien complet fourni par l'expéditeur (avec le fragment #key=...).
        </Alert>
      )}

      <FileList
        files={share?.files || []}
        share={share}
        isLoading={isLoading}
        e2eKey={e2eKey}
      />
    </>
  );
};

export default Share;
