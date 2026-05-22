import {
  Accordion,
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  Collapse,
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
import { useForm } from "@mantine/form";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "../../utils/dayjs";
import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import {
  TbCheck,
  TbCopy,
  TbEye,
  TbEyeOff,
  TbInfoCircle,
  TbKey,
  TbLock,
  TbPencil,
  TbPlus,
  TbQrcode,
  TbTrash,
  TbWorldCheck,
  TbWorldOff,
  TbChevronDown,
} from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import showReverseShareLinkModal from "../../components/account/showReverseShareLinkModal";
import showShareLinkModal from "../../components/account/showShareLinkModal";
import showQrCodeModal from "../../components/core/showQrCodeModal";
import CenterLoader from "../../components/core/CenterLoader";
import showCreateReverseShareModal from "../../components/share/modals/showCreateReverseShareModal";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";

import { MyReverseShare } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { copyToClipboard } from "../../utils/clipboard.util";
import toast from "../../utils/toast.util";
import { getExpirationPreview } from "../../utils/date.util";
import { Timespan } from "../../types/timespan.type";
import {
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";

// -- K_rs display component (similar to master key in E2E settings) --
const RsKeyDisplay = ({ rsKey }: { rsKey: string }) => {
  const t = useTranslate();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const masked = rsKey.slice(0, 8) + "••••••••••••" + rsKey.slice(-8);

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        {t("account.reverseShares.rsKey.description")}
      </Text>
      <Group gap="xs" wrap="nowrap">
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
        <Tooltip label={revealed ? t("account.reverseShares.rsKey.hide") : t("account.reverseShares.rsKey.reveal")}>
          <ActionIcon
            variant="light"
            size="sm"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? <TbEyeOff size={14} /> : <TbEye size={14} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={copied ? t("account.reverseShares.rsKey.copied") : t("account.reverseShares.rsKey.copy")}>
          <ActionIcon
            variant="light"
            size="sm"
            onClick={async () => {
              const ok = await copyToClipboard(rsKey);
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? (
              <TbCheck size={14} color="teal" />
            ) : (
              <TbCopy size={14} />
            )}
          </ActionIcon>
        </Tooltip>
      </Group>
    </Stack>
  );
};

// -- Edit expiration modal body --
const EditExpirationBody = ({
  reverseShareId,
  maxExpiration: _maxExpiration,
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

    // RS link expiration is independent from share.maxExpiration.

    try {
      await shareService.updateReverseShare(reverseShareId, {
        shareExpiration,
      });
      toast.success(t("account.reverseShares.notify.expiration-updated"));
      onSaved();
    } catch {
      toast.error(t("account.reverseShares.notify.expiration-update-failed"));
    }
  });

  return (
    <form onSubmit={handleSubmit}>
      <Stack gap="sm">
        <Grid align={form.errors.expiration_num ? "center" : "flex-end"}>
          <Grid.Col span={{ base: 12, xs: 6 }}>
            <NumberInput
              min={1}
              max={99999}
              decimalScale={0}
              variant="filled"
              label={t("account.reverseShares.modal.expiration.label")}
              disabled={form.values.never_expires}
              {...form.getInputProps("expiration_num")}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, xs: 6 }}>
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
          </Grid.Col>
        </Grid>
        <Checkbox
          label={t("upload.modal.expires.never-long")}
          {...form.getInputProps("never_expires", { type: "checkbox" })}
        />
        <Text
          fs="italic"
          size="xs"
          style={{ color: "var(--mantine-color-gray-6)" }}
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
  const t = useTranslate();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const [expandedRs, setExpandedRs] = useState<string | null>(null);

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

  // Team plan upload limit (no billing)
  const { data: planMaxShareSize } = useQuery({
    queryKey: ["uploadLimit"],
    queryFn: async () => ({ maxSize: 0, usedSize: 0 }), // 0 = no plan limit
    refetchInterval: Infinity,
    refetchOnWindowFocus: false,
  });

  const deleteShareMutation = useMutation({
    mutationFn: (shareId: string) => shareService.remove(shareId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myReverseShares"] });
      toast.success(t("account.shares.notify.deleted-success"));
    },
    onError: () => {
      toast.error(t("account.shares.notify.delete-fail"));
    },
  });

  // Bulk selection (reverse shares)
  const [selectedRs, setSelectedRs] = useState<Set<string>>(new Set());
  const toggleSelectRs = (id: string) => {
    setSelectedRs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllRs = () => {
    if (!reverseShares) return;
    if (selectedRs.size === reverseShares.length) setSelectedRs(new Set());
    else setSelectedRs(new Set(reverseShares.map((rs) => rs.id)));
  };
  const bulkDeleteRs = () => {
    if (selectedRs.size === 0) return;
    const count = selectedRs.size;
    modals.openConfirmModal({
      title: t("account.reverseShares.bulk-delete.title", { count }),
      children: (
        <Text size="sm">
          <FormattedMessage id="account.reverseShares.bulk-delete.description" values={{ count }} />
        </Text>
      ),
      labels: { confirm: t("common.button.delete"), cancel: t("common.button.cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        selectedRs.forEach((id) => deleteReverseShareMutation.mutate(id));
        setSelectedRs(new Set());
      },
    });
  };

  // -- Copier le lien reverse share avec fragment E2E si applicable --
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

    const ok = await copyToClipboard(link);
    if (ok) {
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

    const ok = await copyToClipboard(link);
    if (ok) {
      toast.success(t("common.notify.copied-link"));
    } else {
      showShareLinkModal(modals, shareId);
    }
  };

  // -- Show K_rs in a modal --
  const handleShowRsKey = async (reverseShare: MyReverseShare) => {
    const rsKeyEncoded = await unwrapRsKey(reverseShare);
    if (!rsKeyEncoded) {
      toast.error(t("account.reverseShares.notify.decrypt-key-failed"));
      return;
    }
    modals.openModal({
      title: t("account.reverseShares.rsKey.title"),
      children: <RsKeyDisplay rsKey={rsKeyEncoded} />,
    });
  };

  // -- Edit expiration modal --
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
      <Group justify="space-between" align="baseline" mb={20}>
        <Group align="center" gap={3} mb={30}>
          <Title order={3}>
            <FormattedMessage id="account.reverseShares.title" />
          </Title>
          <Tooltip
            position="bottom"
            multiline
            w={220}
            label={t("account.reverseShares.description")}
            events={{ hover: true, focus: false, touch: true }}
          >
            <ActionIcon color="blue" variant="subtle">
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
              planMaxShareSize?.maxSize,
            )
          }
          leftSection={<TbPlus size={20} />}
        >
          <FormattedMessage id="common.button.create" />
        </Button>
      </Group>
      {reverseShares.length == 0 ? (
        <Center style={{ height: "70vh" }}>
          <Stack align="center" gap={10}>
            <Title order={3}>
              <FormattedMessage id="account.reverseShares.title.empty" />
            </Title>
            <Text>
              <FormattedMessage id="account.reverseShares.description.empty" />
            </Text>
          </Stack>
        </Center>
      ) : isMobile ? (
        /* --- Mobile: card layout with expandable sub-shares --- */
        <Stack gap="sm">
          {reverseShares.length > 0 && (
            <Group justify="space-between">
              <Checkbox
                label={t("account.reverseShares.select-all")}
                checked={selectedRs.size === reverseShares.length}
                indeterminate={selectedRs.size > 0 && selectedRs.size < reverseShares.length}
                onChange={toggleAllRs}
              />
              {selectedRs.size > 0 && (
                <Button size="compact-sm" color="red" variant="light" leftSection={<TbTrash size={16} />} onClick={bulkDeleteRs}>
                  <FormattedMessage id="account.reverseShares.bulk-delete.button" values={{ count: selectedRs.size }} />
                </Button>
              )}
            </Group>
          )}
          {reverseShares.map((reverseShare) => {
            const isOpen = expandedRs === reverseShare.id;
            const hasShares = reverseShare.shares.length > 0;
            return (
              <Card key={reverseShare.id} withBorder padding="sm" radius="md">
                {/* -- RS header card -- */}
                <Group justify="space-between" wrap="nowrap" mb={4}>
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                    <Checkbox
                      size="xs"
                      checked={selectedRs.has(reverseShare.id)}
                      onChange={() => toggleSelectRs(reverseShare.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <Box
                      style={{ minWidth: 0, flex: 1 }}
                      onClick={hasShares ? () => setExpandedRs(isOpen ? null : reverseShare.id) : undefined}
                    >
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600} lineClamp={1}>
                        {reverseShare.name || reverseShare.id}
                      </Text>
                      {reverseShare.publicAccess ? (
                        <TbWorldCheck size={16} color="teal" />
                      ) : (
                        <TbWorldOff size={16} color="gray" />
                      )}
                    </Group>
                  </Box>
                  </Group>
                  {hasShares && (
                    <ActionIcon
                      variant="subtle"
                      size={28}
                      style={{ transition: "transform 200ms", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                    >
                      <TbChevronDown size={18} />
                    </ActionIcon>
                  )}
                </Group>

                {/* -- RS metadata -- */}
                <Group gap="xs" mb={8}>
                  <Text size="xs" c="dimmed">
                    {hasShares
                      ? reverseShare.shares.length === 1
                        ? `1 ${t("account.reverseShares.table.count.singular")}`
                        : `${reverseShare.shares.length} ${t("account.reverseShares.table.count.plural")}`
                      : t("account.reverseShares.table.no-shares")}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t("account.reverseShares.table.max-size")}: {byteToHumanSizeString(parseInt(reverseShare.maxShareSize))}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {dayjs(reverseShare.shareExpiration).unix() === 0
                      ? t("account.shares.table.expiry-never")
                      : `${t("account.reverseShares.table.expires")} ${dayjs(reverseShare.shareExpiration).format("L")}`}
                  </Text>
                  {dayjs(reverseShare.shareExpiration).unix() !== 0 && (
                    <Text size="xs" c="dimmed">
                      <FormattedMessage id="account.reverseShares.table.remaining" />: {reverseShare.remainingUses}
                    </Text>
                  )}
                </Group>

                {/* -- RS action buttons -- */}
                <Group gap={6} mb={hasShares ? 0 : undefined}>
                  {reverseShare.encryptedReverseShareKey && (
                    <ActionIcon color="yellow" variant="light" size={28} onClick={() => handleShowRsKey(reverseShare)}>
                      <TbKey />
                    </ActionIcon>
                  )}
                  {dayjs(reverseShare.shareExpiration).unix() !== 0 && (
                    <ActionIcon color="blue" variant="light" size={28} onClick={() => handleEditExpiration(reverseShare)}>
                      <TbPencil />
                    </ActionIcon>
                  )}
                  <ActionIcon color="teal" variant="light" size={28} onClick={() => handleCopyReverseShareLink(reverseShare)}>
                    <TbCopy />
                  </ActionIcon>
                  <ActionIcon color="grape" variant="light" size={28} onClick={async () => {
                    let link = `${config.get("general.appUrl")}/upload/${reverseShare.token}`;
                    const rsKeyEncoded = await unwrapRsKey(reverseShare);
                    if (rsKeyEncoded) link += `#key=${rsKeyEncoded}`;
                    showQrCodeModal(modals, link);
                  }}>
                    <TbQrcode />
                  </ActionIcon>
                  <ActionIcon color="red" variant="light" size={28} onClick={() => {
                    modals.openConfirmModal({
                      title: t("account.reverseShares.modal.delete.title"),
                      children: <Text size="sm"><FormattedMessage id="account.reverseShares.modal.delete.description" /></Text>,
                      confirmProps: { color: "red" },
                      labels: { confirm: t("common.button.delete"), cancel: t("common.button.cancel") },
                      onConfirm: () => deleteReverseShareMutation.mutate(reverseShare.id),
                    });
                  }}>
                    <TbTrash />
                  </ActionIcon>
                </Group>

                {/* -- Expandable sub-shares -- */}
                {hasShares && (
                  <Collapse in={isOpen}>
                    <Stack gap={6} mt="sm" pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
                      {reverseShare.shares.map((share) => {
                        const shareHref = rsKeyCache[reverseShare.id]
                          ? `/share/${share.id}#key=${rsKeyCache[reverseShare.id]}`
                          : `/share/${share.id}`;
                        return (
                          <Card key={share.id} withBorder padding="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-body)" }}>
                            <Group justify="space-between" wrap="nowrap">
                              <Box style={{ minWidth: 0, flex: 1 }}>
                                <Link href={shareHref} style={{ textDecoration: "none", color: "inherit" }}>
                                  <Text size="xs" fw={500} lineClamp={1} style={{ cursor: "pointer" }}>
                                    {share.name || share.id}
                                  </Text>
                                </Link>
                                {share.description && (
                                  <Text size="xs" c="dimmed" lineClamp={1}>{share.description}</Text>
                                )}
                              </Box>
                              <Group gap={4} wrap="nowrap">
                                {share.security.passwordProtected && <TbLock size={14} color="orange" />}
                                <ActionIcon color="teal" variant="light" size={24} component={Link} href={shareHref}>
                                  <TbEye size={14} />
                                </ActionIcon>
                                <ActionIcon color="teal" variant="light" size={24} onClick={() => handleCopyShareLink(share.id, reverseShare)}>
                                  <TbCopy size={14} />
                                </ActionIcon>
                                <ActionIcon color="red" variant="light" size={24} onClick={() => {
                                  modals.openConfirmModal({
                                    title: t("account.reverseShares.modal.delete-share.title"),
                                    children: <Text size="sm"><FormattedMessage id="account.reverseShares.modal.delete-share.description" /></Text>,
                                    confirmProps: { color: "red" },
                                    labels: { confirm: t("common.button.delete"), cancel: t("common.button.cancel") },
                                    onConfirm: () => deleteShareMutation.mutate(share.id),
                                  });
                                }}>
                                  <TbTrash size={14} />
                                </ActionIcon>
                              </Group>
                            </Group>
                          </Card>
                        );
                      })}
                    </Stack>
                  </Collapse>
                )}
              </Card>
            );
          })}
        </Stack>
      ) : (
        /* --- Desktop: table layout --- */
        <>
          {selectedRs.size > 0 && (
            <Group mb="sm">
              <Button size="compact-sm" color="red" variant="light" leftSection={<TbTrash size={16} />} onClick={bulkDeleteRs}>
                <FormattedMessage id="account.reverseShares.bulk-delete.button" values={{ count: selectedRs.size }} />
              </Button>
            </Group>
          )}
          <Box style={{ display: "block", overflowX: "auto" }}>
          <Table striped highlightOnHover withRowBorders verticalSpacing="sm" style={{ tableLayout: "fixed" }}>
            <Table.Thead style={{ textAlign: "left" }}>
              <Table.Tr>
                <Table.Th style={{ width: "3%" }}>
                  <Checkbox
                    size="xs"
                    checked={selectedRs.size === reverseShares.length && reverseShares.length > 0}
                    indeterminate={selectedRs.size > 0 && selectedRs.size < reverseShares.length}
                    onChange={toggleAllRs}
                  />
                </Table.Th>
                <Table.Th style={{ width: "25%" }}>
                  <FormattedMessage id="account.reverseShares.table.shares" />
                </Table.Th>
                <Table.Th style={{ width: "18%" }}>
                  <FormattedMessage id="account.shares.table.name" />
                </Table.Th>
                <Table.Th style={{ width: "8%", textAlign: "center" }}>
                  <FormattedMessage id="account.reverseShares.table.public-access" />
                </Table.Th>
                <Table.Th style={{ width: "10%" }}>
                  <FormattedMessage id="account.reverseShares.table.remaining" />
                </Table.Th>
                <Table.Th style={{ width: "13%" }}>
                  <FormattedMessage id="account.reverseShares.table.max-size" />
                </Table.Th>
                <Table.Th style={{ whiteSpace: "nowrap", width: "16%" }}>
                  <FormattedMessage id="account.reverseShares.table.expires" />
                </Table.Th>
                <Table.Th style={{ width: "7%" }}></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {reverseShares.map((reverseShare) => (
                <Table.Tr key={reverseShare.id}>
                  <Table.Td>
                    <Checkbox
                      size="xs"
                      checked={selectedRs.has(reverseShare.id)}
                      onChange={() => toggleSelectRs(reverseShare.id)}
                    />
                  </Table.Td>
                  <Table.Td>
                    {reverseShare.shares.length == 0 ? (
                      <Text c="dimmed" size="sm">
                        <FormattedMessage id="account.reverseShares.table.no-shares" />
                      </Text>
                    ) : (
                      <Accordion>
                        <Accordion.Item
                          value="customization"
                          style={{ borderBottom: "none" }}
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
                              <Stack key={share.id} mb={6} gap={2}>
                                <Group gap="xs" justify="space-between" wrap="nowrap">
                                  <Box style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                                    <Link
                                      href={
                                        rsKeyCache[reverseShare.id]
                                          ? `/share/${share.id}#key=${rsKeyCache[reverseShare.id]}`
                                          : `/share/${share.id}`
                                      }
                                      style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}
                                    >
                                      <Text truncate size="sm" style={{ cursor: "pointer" }}>
                                        {share.name || share.id}
                                      </Text>
                                    </Link>
                                  </Box>
                                  <Group gap={4} wrap="nowrap">
                                    {share.security.passwordProtected && (
                                      <Tooltip
                                        label={t(
                                          "account.reverseShares.table.password-protected",
                                        )}
                                        withArrow
                                      >
                                        <ThemeIcon color="orange" variant="light" size={25}>
                                          <TbLock size={14} />
                                        </ThemeIcon>
                                      </Tooltip>
                                    )}
                                <Tooltip label={t("account.reverseShares.table.view-files")}>
                                  <ActionIcon
                                    color="teal"
                                    variant="light"
                                    size={25}
                                    component={Link}
                                    href={
                                      rsKeyCache[reverseShare.id]
                                        ? `/share/${share.id}#key=${rsKeyCache[reverseShare.id]}`
                                        : `/share/${share.id}`
                                    }
                                  >
                                    <TbEye />
                                  </ActionIcon>
                                </Tooltip>
                                <ActionIcon
                                  color="teal"
                                  variant="light"
                                  size={25}
                                  onClick={() =>
                                    handleCopyShareLink(share.id, reverseShare)
                                  }
                                >
                                  <TbCopy />
                                </ActionIcon>
                                <ActionIcon
                                  color="red"
                                  variant="light"
                                  size={25}
                                  onClick={() => {
                                    modals.openConfirmModal({
                                      title: t("account.reverseShares.modal.delete-share.title"),
                                      children: (
                                        <Text size="sm">
                                          <FormattedMessage id="account.reverseShares.modal.delete-share.description" />
                                        </Text>
                                      ),
                                      confirmProps: { color: "red" },
                                      labels: {
                                        confirm: t("common.button.delete"),
                                        cancel: t("common.button.cancel"),
                                      },
                                      onConfirm: () =>
                                        deleteShareMutation.mutate(share.id),
                                    });
                                  }}
                                >
                                  <TbTrash />
                                </ActionIcon>
                                  </Group>
                                </Group>
                                {share.description && (
                                  <Text size="xs" c="dimmed" maw={200} truncate>
                                    {share.description}
                                  </Text>
                                )}
                              </Stack>
                            ))}
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                    )}
                  </Table.Td>
                  <Table.Td>{reverseShare.name}</Table.Td>
                  <Table.Td style={{ textAlign: "center" }}>
                    {reverseShare.publicAccess ? (
                      <ThemeIcon color="green" variant="light">
                        <TbWorldCheck size="1.2rem" />
                      </ThemeIcon>
                    ) : (
                      <ThemeIcon color="red" variant="light">
                        <TbWorldOff size="1.2rem" />
                      </ThemeIcon>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {dayjs(reverseShare.shareExpiration).unix() === 0
                      ? "∞"
                      : reverseShare.remainingUses}
                  </Table.Td>
                  <Table.Td>
                    {byteToHumanSizeString(parseInt(reverseShare.maxShareSize))}
                  </Table.Td>
                  <Table.Td>
                    {dayjs(reverseShare.shareExpiration).unix() === 0
                      ? "Never"
                      : dayjs(reverseShare.shareExpiration).format("LLL")}
                  </Table.Td>
                  <Table.Td>
                    <Group justify="right" gap={4}>
                      {reverseShare.encryptedReverseShareKey && (
                        <Tooltip label={t("account.reverseShares.table.show-key")}>
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
                      {dayjs(reverseShare.shareExpiration).unix() !== 0 && (
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
                      )}
                      <ActionIcon
                        color="teal"
                        variant="light"
                        size={25}
                        onClick={() => handleCopyReverseShareLink(reverseShare)}
                      >
                        <TbCopy />
                      </ActionIcon>
                      <ActionIcon
                        color="grape"
                        variant="light"
                        size={25}
                        onClick={async () => {
                          let link = `${config.get("general.appUrl")}/upload/${reverseShare.token}`;
                          const rsKeyEncoded = await unwrapRsKey(reverseShare);
                          if (rsKeyEncoded) {
                            link += `#key=${rsKeyEncoded}`;
                          }
                          showQrCodeModal(modals, link);
                        }}
                      >
                        <TbQrcode />
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
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
        </>
      )}
    </>
  );
};

export default MyShares;
