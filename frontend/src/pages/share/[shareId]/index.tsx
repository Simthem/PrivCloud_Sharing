import { Alert, Box, Group, Text, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { GetServerSidePropsContext } from "next";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { TbLock } from "react-icons/tb";
import Meta from "../../../components/Meta";
import DownloadAllButton from "../../../components/share/DownloadAllButton";
import FileCardGrid from "../../../components/share/FileCardGrid";
import FileList from "../../../components/share/FileList";
import showEnterPasswordModal from "../../../components/share/showEnterPasswordModal";
import useUser from "../../../hooks/user.hook";
import showCaptchaModal from "../../../components/share/showCaptchaModal";
import showErrorModal from "../../../components/share/showErrorModal";
import useTranslate from "../../../hooks/useTranslate.hook";
import useConfig from "../../../hooks/config.hook";
import shareService from "../../../services/share.service";
import { Share as ShareType } from "../../../types/share.type";
import toast from "../../../utils/toast.util";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";
import { extractKeyFromHash, getUserKey, unwrapReverseShareKey, importKeyFromBase64, exportKeyToBase64 } from "../../../utils/crypto.util";
import { AxiosError } from "axios";
import { deleteCookie } from "cookies-next";

export function getServerSideProps(context: GetServerSidePropsContext) {
  return {
    props: { shareId: context.params!.shareId },
  };
}

const Share = ({ shareId }: { shareId: string }) => {
  const modals = useModals();
  const config = useConfig();
  const { user } = useUser();

  // Always clear the share token cookie on each visit so password
  // protected shares always require re-authentication.
  const [tokenCleared, setTokenCleared] = useState(false);
  useEffect(() => {
    deleteCookie(`share_${shareId}_token`, { path: "/" });
    setTokenCleared(true);
  }, [shareId]);

  const {
    data: share,
    error,
    refetch,
    isLoading,
  } = useQuery<ShareType>({
    queryKey: ["share", shareId],
    retry: false,
    queryFn: () => shareService.get(shareId),
    enabled: tokenCleared,
  });

  const t = useTranslate();

  const captchaEnabled = config.get("hcaptcha.enabled");
  const captchaSiteKey = config.get("hcaptcha.siteKey");

  // ── E2E : résolution de la clé de déchiffrement ──
  // Priorité : #key= dans l'URL > K_rs unwrappée (reverse share) > K_master (share normal)
  const [e2eKey, setE2eKey] = useState<string | null>(null);

  // Phase 1 : clé depuis le fragment d'URL (disponible immédiatement)
  useEffect(() => {
    const hashKey = extractKeyFromHash();
    if (hashKey) {
      setE2eKey(hashKey);
    }
  }, [shareId]);

  // Phase 2 : une fois le share chargé, résoudre la clé si manquante
  // - Reverse share E2E → unwrap K_rs via backend endpoint
  // - Share E2E normal  → K_master depuis localStorage
  // - Erreur (non-owner, non-auth) → laisser e2eKey null → alerte "clé manquante"
  useEffect(() => {
    if (e2eKey || !share?.isE2EEncrypted) return;

    const userKeyB64 = getUserKey();
    if (!userKeyB64) return;

    let cancelled = false;

    (async () => {
      try {
        // Endpoint retourne 200 dans tous les cas sauf 403 :
        //   { encryptedReverseShareKey: null }   → pas un reverse share → K_master
        //   { encryptedReverseShareKey: "..." }  → reverse share → unwrap K_rs
        const encrypted = await shareService.getEncryptedE2eKey(shareId);
        if (cancelled) return;

        if (encrypted) {
          // C'est un reverse share - unwrap K_rs avec K_master
          const masterKey = await importKeyFromBase64(userKeyB64);
          const rsKey = await unwrapReverseShareKey(encrypted, masterKey);
          const rsKeyB64 = await exportKeyToBase64(rsKey);
          if (!cancelled) setE2eKey(rsKeyB64);
        } else {
          // Pas un reverse share (backend a retourné null) → fallback K_master
          if (!cancelled) setE2eKey(userKeyB64);
        }
      } catch (err) {
        // 403 = reverse share mais pas le propriétaire, ou erreur réseau/déchiffrement.
        // NE PAS fallback sur K_master (ce serait la mauvaise clé).
        // Laisser e2eKey null → l'alerte "clé manquante" s'affichera.
        console.error("[E2E] Failed to resolve reverse share key:", err);
      }
    })();

    return () => { cancelled = true; };
  }, [share?.isE2EEncrypted, e2eKey, shareId]);

  const isE2EMissingKey = share?.isE2EEncrypted && !e2eKey;

  const getShareToken = async (password?: string, captchaToken?: string) => {
    await shareService
      .getShareToken(shareId, password, captchaToken)
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
          showEnterPasswordModal(
            modals,
            getShareToken,
            captchaEnabled && captchaSiteKey ? captchaSiteKey : undefined,
          );
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
      showEnterPasswordModal(
        modals,
        getShareToken,
        captchaEnabled && captchaSiteKey ? captchaSiteKey : undefined,
      );
    } else if (errorData.error == "private_share") {
      showErrorModal(
        modals,
        t("share.error.access-denied.title"),
        t("share.error.access-denied.description"),
        "go-home",
      );
    } else if (errorData.error == "share_token_required") {
      if (captchaEnabled && captchaSiteKey) {
        showCaptchaModal(modals, captchaSiteKey, getShareToken);
      } else {
        getShareToken();
      }
    } else {
      showErrorModal(
        modals,
        t("common.error"),
        t("common.error.unknown"),
        "go-home",
      );
    }
  }, [error]);

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
          <DownloadAllButton
            shareId={shareId}
            isE2EEncrypted={share?.isE2EEncrypted}
            e2eKey={e2eKey}
            files={share?.files}
          />
        )}
      </Group>

      {isE2EMissingKey && (
        <Alert
          icon={<TbLock size={16} />}
          title="Chiffrement de bout en bout"
          color="red"
          mb="lg"
        >
          Ce partage est chiffré de bout en bout. La clé de déchiffrement est
          manquante dans l'URL. Veuillez utiliser le lien complet fourni par
          l'expéditeur (avec le fragment #key=...).
        </Alert>
      )}

      <FileList
        files={share?.files || []}
        share={share}
        isLoading={isLoading}
        e2eKey={e2eKey}
      />

      {/* Creator card grid: when the RS owner or share creator visits,
          show a visual preview grid alongside the standard file table. */}
      {user &&
        (share?.creator?.id === user.id ||
          share?.reverseShare?.creatorId === user.id) && (
        <>
          <Title order={5} mt="xl" mb="sm">
            <FormattedMessage id="share.creator-preview" defaultMessage="File overview" />
          </Title>
          <FileCardGrid
            files={share.files || []}
            share={share}
            isLoading={isLoading}
            e2eKey={e2eKey}
          />
        </>
      )}
    </>
  );
};

export default Share;
