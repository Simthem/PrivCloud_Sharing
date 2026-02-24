import {
  Accordion,
  ActionIcon,
  Anchor,
  Box,
  Button,
  Center,
  Group,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import moment from "moment";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { TbInfoCircle, TbLink, TbLock, TbPlus, TbTrash, TbWorld, TbWorldCancel, TbWorldCheck, TbWorldOff } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import showReverseShareLinkModal from "../../components/account/showReverseShareLinkModal";
import showShareLinkModal from "../../components/account/showShareLinkModal";
import CenterLoader from "../../components/core/CenterLoader";
import showCreateReverseShareModal from "../../components/share/modals/showCreateReverseShareModal";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import { MyReverseShare } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import toast from "../../utils/toast.util";
import {
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";

const MyShares = () => {
  const modals = useModals();
  const clipboard = useClipboard();
  const t = useTranslate();
  const queryClient = useQueryClient();

  const config = useConfig();

  const {
    data: reverseShares,
    isLoading,
    isError,
    refetch
  } = useQuery<MyReverseShare[]>({
    queryKey: ["myReverseShares"],
    queryFn: shareService.getMyReverseShares,
  });

  const deleteReverseShareMutation = useMutation({
    mutationFn: (reverseShare: string) => shareService.removeReverseShare(reverseShare),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myReverseShares"] });
      toast.success(t("account.shares.notify.deleted-success"));
    },
    onError: () => {
      toast.error(t("account.shares.notify.delete-fail"));
    },
  });

  // ── Copier le lien reverse share avec fragment E2E si applicable ──
  // Cache des clés K_rs déchiffrées : reverseShareId → base64url de K_rs
  const [rsKeyCache, setRsKeyCache] = useState<Record<string, string>>({});

  const unwrapRsKey = useCallback(
    async (reverseShare: MyReverseShare): Promise<string | null> => {
      if (!reverseShare.encryptedReverseShareKey) return null;

      // Retourner depuis le cache si disponible
      if (rsKeyCache[reverseShare.id]) return rsKeyCache[reverseShare.id];

      try {
        const masterKeyEncoded = getUserKey();
        if (!masterKeyEncoded) return null;
        const masterKey = await importKeyFromBase64(masterKeyEncoded);
        const rsKey = await unwrapReverseShareKey(
          reverseShare.encryptedReverseShareKey,
          masterKey,
        );
        const rsKeyEncoded = await exportKeyToBase64(rsKey);
        setRsKeyCache((prev) => ({ ...prev, [reverseShare.id]: rsKeyEncoded }));
        return rsKeyEncoded;
      } catch (e) {
        console.error("Erreur lors du déchiffrement de la clé reverse share", e);
        return null;
      }
    },
    [rsKeyCache],
  );

  // Pré-déchiffrer les clés au chargement
  useEffect(() => {
    if (!reverseShares) return;
    reverseShares.forEach((rs) => {
      if (rs.encryptedReverseShareKey && !rsKeyCache[rs.id]) {
        unwrapRsKey(rs);
      }
    });
  }, [reverseShares]);

  const handleCopyReverseShareLink = async (reverseShare: MyReverseShare) => {
    let link = `${config.get("general.appUrl")}/upload/${reverseShare.token}`;

    const rsKeyEncoded = await unwrapRsKey(reverseShare);
    if (rsKeyEncoded) {
      link += `#key=${rsKeyEncoded}`;
    }

    if (window.isSecureContext) {
      clipboard.copy(link);
      toast.success(t("common.notify.copied-link"));
    } else {
      showReverseShareLinkModal(modals, link);
    }
  };

  // Copier le lien d'un share reçu via reverse share (avec K_rs)
  const handleCopyShareLink = async (
    shareId: string,
    reverseShare: MyReverseShare,
  ) => {
    let link = `${config.get("general.appUrl")}/s/${shareId}`;

    const rsKeyEncoded = await unwrapRsKey(reverseShare);
    if (rsKeyEncoded) {
      link += `#key=${rsKeyEncoded}`;
    }

    if (window.isSecureContext) {
      clipboard.copy(link);
      toast.success(t("common.notify.copied-link"));
    } else {
      showShareLinkModal(modals, shareId);
    }
  };

  if (isError) {
    return (
      <Center style={{ height: "70vh" }}>
        <Stack align="center">
          <Title order={3} size={100}>
            {t("error.description")}
          </Title>
          <Text mt="xl" size="lg">
            {t("error.msg.default")}
          </Text>
          <Button onClick={() => refetch()} variant="light">
            <FormattedMessage id="common.button.retry" />
          </Button>
        </Stack>
      </Center>
    );
  }

  if (isLoading || !reverseShares) return <CenterLoader />;

  return (
    <>
      <Meta title={t("account.reverseShares.title")} />
      <Group position="apart" align="baseline" mb={20}>
        <Group align="center" spacing={3} mb={30}>
          <Title order={3}>
            <FormattedMessage id="account.reverseShares.title" />
          </Title>
          <Tooltip
            position="bottom"
            multiline
            width={220}
            label={t("account.reverseShares.description")}
            events={{ hover: true, focus: false, touch: true }}
          >
            <ActionIcon>
              <TbInfoCircle />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Button
          onClick={() =>
            showCreateReverseShareModal(
              modals,
              config.get("smtp.enabled"),
              config.get("share.maxExpiration"),
              refetch,
            )
          }
          leftIcon={<TbPlus size={20} />}
        >
          <FormattedMessage id="common.button.create" />
        </Button>
      </Group>
      {reverseShares.length == 0 ? (
        <Center style={{ height: "70vh" }}>
          <Stack align="center" spacing={10}>
            <Title order={3}>
              <FormattedMessage id="account.reverseShares.title.empty" />
            </Title>
            <Text>
              <FormattedMessage id="account.reverseShares.description.empty" />
            </Text>
          </Stack>
        </Center>
      ) : (
        <Box sx={{ display: "block", overflowX: "auto" }}>
          <Table>
            <thead>
              <tr>
                <th>
                  <FormattedMessage id="account.reverseShares.table.shares" />
                </th>
                <th>
                  <FormattedMessage id="account.shares.table.name" />
                </th>
                <th>
                  <FormattedMessage id="account.reverseShares.table.public-access" />
                </th>
                <th>
                  <FormattedMessage id="account.reverseShares.table.remaining" />
                </th>
                <th>
                  <FormattedMessage id="account.reverseShares.table.max-size" />
                </th>
                <th>
                  <FormattedMessage id="account.reverseShares.table.expires" />
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {reverseShares.map((reverseShare) => (
                <tr key={reverseShare.id}>
                  <td style={{ width: 220 }}>
                    {reverseShare.shares.length == 0 ? (
                      <Text color="dimmed" size="sm">
                        <FormattedMessage id="account.reverseShares.table.no-shares" />
                      </Text>
                    ) : (
                      <Accordion>
                        <Accordion.Item
                          value="customization"
                          sx={{ borderBottom: "none" }}
                        >
                          <Accordion.Control p={0}>
                            <Text size="sm">
                              {reverseShare.shares.length == 1
                                ? `1 ${t(
                                  "account.reverseShares.table.count.singular",
                                )}`
                                : `${reverseShare.shares.length} ${t(
                                  "account.reverseShares.table.count.plural",
                                )}`}
                            </Text>
                          </Accordion.Control>
                          <Accordion.Panel>
                            {reverseShare.shares.map((share) => (
                              <Group key={share.id} mb={4} spacing="xs">
                                <Anchor
                                  href={
                                    rsKeyCache[reverseShare.id]
                                      ? `${config.get("general.appUrl")}/share/${share.id}#key=${rsKeyCache[reverseShare.id]}`
                                      : `${config.get("general.appUrl")}/share/${share.id}`
                                  }
                                  target="_blank"
                                >
                                  <Text maw={120} truncate>
                                    {share.id}
                                  </Text>
                                </Anchor>
                                {share.security.passwordProtected && (
                                  <Tooltip label={t("account.reverseShares.table.password-protected")} withArrow>
                                    <ThemeIcon color="orange" variant="light"><TbLock size="1rem" /></ThemeIcon>
                                  </Tooltip>
                                )}
                                <ActionIcon
                                  color="victoria"
                                  variant="light"
                                  size={25}
                                  onClick={() =>
                                    handleCopyShareLink(share.id, reverseShare)
                                  }
                                >
                                  <TbLink />
                                </ActionIcon>
                              </Group>
                            ))}
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                    )}
                  </td>
                  <td>{reverseShare.name}</td>
                  <td style={{ textAlign: "center" }}>{reverseShare.publicAccess ? (
                      <ThemeIcon color="green" variant="light"><TbWorldCheck size="1.2rem" /></ThemeIcon>
                    ) : (
                      <ThemeIcon color="red" variant="light"><TbWorldOff size="1.2rem" /></ThemeIcon>
                    )
                  }</td>
                  <td>{reverseShare.remainingUses}</td>
                  <td>
                    {byteToHumanSizeString(parseInt(reverseShare.maxShareSize))}
                  </td>
                  <td>
                    {moment(reverseShare.shareExpiration).unix() === 0
                      ? "Never"
                      : moment(reverseShare.shareExpiration).format("LLL")}
                  </td>
                  <td>
                    <Group position="right">
                      <ActionIcon
                        color="victoria"
                        variant="light"
                        size={25}
                        onClick={() => handleCopyReverseShareLink(reverseShare)}
                      >
                        <TbLink />
                      </ActionIcon>
                      <ActionIcon
                        color="red"
                        variant="light"
                        size={25}
                        onClick={() => {
                          modals.openConfirmModal({
                            title: t(
                              "account.reverseShares.modal.delete.title",
                            ),
                            children: (
                              <Text size="sm">
                                <FormattedMessage id="account.reverseShares.modal.delete.description" />
                              </Text>
                            ),
                            confirmProps: {
                              color: "red",
                            },
                            labels: {
                              confirm: t("common.button.delete"),
                              cancel: t("common.button.cancel"),
                            },
                            onConfirm: () => deleteReverseShareMutation.mutate(reverseShare.id),
                          });
                        }}
                      >
                        <TbTrash />
                      </ActionIcon>
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Box>
      )}
    </>
  );
};

export default MyShares;
