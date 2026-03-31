import {
  Accordion,
  ActionIcon,
  Anchor,
  Box,
  Button,
  Center,
  Checkbox,
  Code,
  Col,
  CopyButton,
  Grid,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { useForm } from "@mantine/form";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import moment from "moment";
import React, { useCallback, useEffect, useState } from "react";
import {
  TbCheck,
  TbCopy,
  TbEye,
  TbEyeOff,
  TbInfoCircle,
  TbKey,
  TbLink,
  TbLock,
  TbPencil,
  TbPlus,
  TbTrash,
  TbWorldCheck,
  TbWorldOff,
} from "react-icons/tb";
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
import { getExpirationPreview } from "../../utils/date.util";
import { Timespan } from "../../types/timespan.type";
import {
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";

// ── K_rs display component (similar to master key in E2E settings) ──
const RsKeyDisplay = ({ rsKey }: { rsKey: string }) => {
  const [revealed, setRevealed] = useState(false);
  const masked = rsKey.slice(0, 8) + "••••••••••••" + rsKey.slice(-8);

  return (
    <Stack spacing="xs">
      <Text size="sm" color="dimmed">
        AES-256 encryption key for this reverse share. Store it safely --
        without it, uploaded files cannot be decrypted.
      </Text>
      <Group spacing="xs" noWrap>
        <Code
          block
          style={{
            flex: 1,
            wordBreak: "break-all",
            fontSize: "0.75rem",
            userSelect: revealed ? "all" : "none",
          }}
        >
          {revealed ? rsKey : masked}
        </Code>
        <Tooltip label={revealed ? "Hide" : "Reveal"}>
          <ActionIcon
            variant="light"
            size="sm"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? <TbEyeOff size={14} /> : <TbEye size={14} />}
          </ActionIcon>
        </Tooltip>
        <CopyButton value={rsKey}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? "Copied!" : "Copy"}>
              <ActionIcon variant="light" size="sm" onClick={copy}>
                {copied ? (
                  <TbCheck size={14} color="teal" />
                ) : (
                  <TbCopy size={14} />
                )}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
};

// ── Edit expiration modal body ──
const EditExpirationBody = ({
  reverseShareId,
  maxExpiration,
  onSaved,
}: {
  reverseShareId: string;
  maxExpiration: Timespan;
  onSaved: () => void;
}) => {
  const t = useTranslate();

  const form = useForm({
    initialValues: {
      never_expires: false,
      expiration_num: 1,
      expiration_unit: "-days",
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    const shareExpiration = values.never_expires
      ? "never"
      : values.expiration_num + values.expiration_unit;

    if (!values.never_expires && maxExpiration.value !== 0) {
      const expirationDate = moment().add(
        values.expiration_num,
        values.expiration_unit.replace(
          "-",
          "",
        ) as moment.unitOfTime.DurationConstructor,
      );
      if (
        expirationDate.isAfter(
          moment().add(maxExpiration.value, maxExpiration.unit),
        )
      ) {
        form.setFieldError("expiration_num", "Exceeds max expiration");
        return;
      }
    }

    try {
      await shareService.updateReverseShare(reverseShareId, {
        shareExpiration,
      });
      toast.success("Expiration updated");
      onSaved();
    } catch {
      toast.error("Failed to update expiration");
    }
  });

  return (
    <form onSubmit={handleSubmit}>
      <Stack spacing="sm">
        <Grid align={form.errors.expiration_num ? "center" : "flex-end"}>
          <Col xs={6}>
            <NumberInput
              min={1}
              max={99999}
              precision={0}
              variant="filled"
              label={t("account.reverseShares.modal.expiration.label")}
              disabled={form.values.never_expires}
              {...form.getInputProps("expiration_num")}
            />
          </Col>
          <Col xs={6}>
            <Select
              disabled={form.values.never_expires}
              {...form.getInputProps("expiration_unit")}
              data={[
                {
                  value: "-minutes",
                  label:
                    form.values.expiration_num == 1
                      ? t("upload.modal.expires.minute-singular")
                      : t("upload.modal.expires.minute-plural"),
                },
                {
                  value: "-hours",
                  label:
                    form.values.expiration_num == 1
                      ? t("upload.modal.expires.hour-singular")
                      : t("upload.modal.expires.hour-plural"),
                },
                {
                  value: "-days",
                  label:
                    form.values.expiration_num == 1
                      ? t("upload.modal.expires.day-singular")
                      : t("upload.modal.expires.day-plural"),
                },
                {
                  value: "-weeks",
                  label:
                    form.values.expiration_num == 1
                      ? t("upload.modal.expires.week-singular")
                      : t("upload.modal.expires.week-plural"),
                },
                {
                  value: "-months",
                  label:
                    form.values.expiration_num == 1
                      ? t("upload.modal.expires.month-singular")
                      : t("upload.modal.expires.month-plural"),
                },
                {
                  value: "-years",
                  label:
                    form.values.expiration_num == 1
                      ? t("upload.modal.expires.year-singular")
                      : t("upload.modal.expires.year-plural"),
                },
              ]}
            />
          </Col>
        </Grid>
        {maxExpiration.value == 0 && (
          <Checkbox
            label={t("upload.modal.expires.never-long")}
            {...form.getInputProps("never_expires", { type: "checkbox" })}
          />
        )}
        <Text
          italic
          size="xs"
          sx={(theme) => ({ color: theme.colors.gray[6] })}
        >
          {getExpirationPreview(
            {
              neverExpires: t("account.reverseShare.never-expires"),
              expiresOn: t("account.reverseShare.expires-on"),
            },
            form,
          )}
        </Text>
        <Button type="submit" mt="xs">
          <FormattedMessage id="common.button.save" />
        </Button>
      </Stack>
    </form>
  );
};

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
    refetch,
  } = useQuery<MyReverseShare[]>({
    queryKey: ["myReverseShares"],
    queryFn: shareService.getMyReverseShares,
  });

  const deleteReverseShareMutation = useMutation({
    mutationFn: (reverseShare: string) =>
      shareService.removeReverseShare(reverseShare),
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
        console.error(
          "Erreur lors du déchiffrement de la clé reverse share",
          e,
        );
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

  // ── Show K_rs in a modal ──
  const handleShowRsKey = async (reverseShare: MyReverseShare) => {
    const rsKeyEncoded = await unwrapRsKey(reverseShare);
    if (!rsKeyEncoded) {
      toast.error("Unable to decrypt the reverse share key");
      return;
    }
    modals.openModal({
      title: "Reverse share encryption key",
      children: <RsKeyDisplay rsKey={rsKeyEncoded} />,
    });
  };

  // ── Edit expiration modal ──
  const handleEditExpiration = (reverseShare: MyReverseShare) => {
    modals.openModal({
      title: t("account.reverseShares.table.expires"),
      children: (
        <EditExpirationBody
          reverseShareId={reverseShare.id}
          maxExpiration={config.get("share.maxExpiration")}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["myReverseShares"] });
            modals.closeAll();
          }}
        />
      ),
    });
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
                                  <Tooltip
                                    label={t(
                                      "account.reverseShares.table.password-protected",
                                    )}
                                    withArrow
                                  >
                                    <ThemeIcon color="orange" variant="light">
                                      <TbLock size="1rem" />
                                    </ThemeIcon>
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
                  <td style={{ textAlign: "center" }}>
                    {reverseShare.publicAccess ? (
                      <ThemeIcon color="green" variant="light">
                        <TbWorldCheck size="1.2rem" />
                      </ThemeIcon>
                    ) : (
                      <ThemeIcon color="red" variant="light">
                        <TbWorldOff size="1.2rem" />
                      </ThemeIcon>
                    )}
                  </td>
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
                    <Group position="right" spacing={4}>
                      {reverseShare.encryptedReverseShareKey && (
                        <Tooltip label="Show encryption key">
                          <ActionIcon
                            color="yellow"
                            variant="light"
                            size={25}
                            onClick={() => handleShowRsKey(reverseShare)}
                          >
                            <TbKey />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      <Tooltip label={t("account.reverseShares.table.expires")}>
                        <ActionIcon
                          color="blue"
                          variant="light"
                          size={25}
                          onClick={() => handleEditExpiration(reverseShare)}
                        >
                          <TbPencil />
                        </ActionIcon>
                      </Tooltip>
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
                            onConfirm: () =>
                              deleteReverseShareMutation.mutate(
                                reverseShare.id,
                              ),
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
