import {
  Accordion,
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  Col,
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
  TbLink,
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
    <Stack spacing="xs">
      <Text size="sm" color="dimmed">
        {t("account.reverseShares.rsKey.description")}
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
        <Checkbox
          label={t("upload.modal.expires.never-long")}
          {...form.getInputProps("never_expires", { type: "checkbox" })}
        />
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

  // -- Copy reverse share link with E2E fragment if applicable --
  // Cache of decrypted K_rs keys: reverseShareId -> base64url of K_rs
  const [rsKeyCache, setRsKeyCache] = useState<Record<string, string>>({});

  const unwrapRsKey = useCallback(
    async (reverseShare: MyReverseShare): Promise<string | null> => {
      if (!reverseShare.encryptedReverseShareKey) return null;

      // Return from cache if available
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
          "Failed to decrypt reverse share key",
          e,
        );
        return null;
      }
    },
    [rsKeyCache],
  );

  // Pre-decrypt keys on load
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

  // Copy the link for a share received via reverse share (with K_rs)
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
      ) : isMobile ? (
        /* Mobile: card layout with expandable sub-shares */
        <Stack spacing="sm">
          {reverseShares.map((reverseShare) => {
            const isOpen = expandedRs === reverseShare.id;
            const hasShares = reverseShare.shares.length > 0;
            return (
              <Card key={reverseShare.id} withBorder padding="sm" radius="md">
                {/* RS header card */}
                <Group position="apart" noWrap mb={4}
                  onClick={hasShares ? () => setExpandedRs(isOpen ? null : reverseShare.id) : undefined}
                  sx={hasShares ? { cursor: "pointer" } : undefined}
                >
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Group spacing={6} noWrap>
                      <Text size="sm" weight={600} lineClamp={1}>
                        {reverseShare.name || reverseShare.id}
                      </Text>
                      {reverseShare.publicAccess ? (
                        <TbWorldCheck size={16} color="teal" />
                      ) : (
                        <TbWorldOff size={16} color="gray" />
                      )}
                    </Group>
                  </Box>
                  {hasShares && (
                    <ActionIcon
                      variant="subtle"
                      size={28}
                      sx={{ transition: "transform 200ms", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                    >
                      <TbChevronDown size={18} />
                    </ActionIcon>
                  )}
                </Group>

                {/* RS metadata */}
                <Group spacing="xs" mb={8}>
                  <Text size="xs" color="dimmed">
                    {hasShares
                      ? reverseShare.shares.length === 1
                        ? `1 ${t("account.reverseShares.table.count.singular")}`
                        : `${reverseShare.shares.length} ${t("account.reverseShares.table.count.plural")}`
                      : t("account.reverseShares.table.no-shares")}
                  </Text>
                  <Text size="xs" color="dimmed">
                    {t("account.reverseShares.table.max-size")}: {byteToHumanSizeString(parseInt(reverseShare.maxShareSize))}
                  </Text>
                  <Text size="xs" color="dimmed">
                    {dayjs(reverseShare.shareExpiration).unix() === 0
                      ? t("account.shares.table.expiry-never")
                      : `${t("account.reverseShares.table.expires")} ${dayjs(reverseShare.shareExpiration).format("L")}`}
                  </Text>
                  {dayjs(reverseShare.shareExpiration).unix() !== 0 && (
                    <Text size="xs" color="dimmed">
                      <FormattedMessage id="account.reverseShares.table.remaining" />: {reverseShare.remainingUses}
                    </Text>
                  )}
                </Group>

                {/* RS action buttons */}
                <Group spacing={6} mb={hasShares ? 0 : undefined}>
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
                  <ActionIcon variant="light" size={28} onClick={() => handleCopyReverseShareLink(reverseShare)}>
                    <TbLink />
                  </ActionIcon>
                  <ActionIcon variant="light" size={28} onClick={async () => {
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

                {/* Expandable sub-shares */}
                {hasShares && (
                  <Collapse in={isOpen}>
                    <Stack spacing={6} mt="sm" pt="sm" sx={(theme) => ({ borderTop: `1px solid ${theme.colorScheme === "dark" ? theme.colors.dark[4] : theme.colors.gray[2]}` })}>
                      {reverseShare.shares.map((share) => {
                        const shareHref = rsKeyCache[reverseShare.id]
                          ? `/share/${share.id}#key=${rsKeyCache[reverseShare.id]}`
                          : `/share/${share.id}`;
                        return (
                          <Card key={share.id} withBorder padding="xs" radius="sm" sx={(theme) => ({ backgroundColor: theme.colorScheme === "dark" ? theme.colors.dark[6] : theme.colors.gray[0] })}>
                            <Group position="apart" noWrap>
                              <Box style={{ minWidth: 0, flex: 1 }}>
                                <Link href={shareHref} style={{ textDecoration: "none", color: "inherit" }}>
                                  <Text size="xs" weight={500} lineClamp={1} sx={{ "&:hover": { textDecoration: "underline" } }}>
                                    {share.name || share.id}
                                  </Text>
                                </Link>
                                {share.description && (
                                  <Text size="xs" color="dimmed" lineClamp={1}>{share.description}</Text>
                                )}
                              </Box>
                              <Group spacing={4} noWrap>
                                {share.security.passwordProtected && <TbLock size={14} color="orange" />}
                                <ActionIcon color="teal" variant="light" size={24} component={Link} href={shareHref}>
                                  <TbEye size={14} />
                                </ActionIcon>
                                <ActionIcon variant="light" size={24} onClick={() => handleCopyShareLink(share.id, reverseShare)}>
                                  <TbLink size={14} />
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
        /* Desktop: table layout */
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
                              <Stack key={share.id} mb={6} spacing={2}>
                                <Group spacing="xs">
                                  <Link
                                    href={
                                      rsKeyCache[reverseShare.id]
                                        ? `/share/${share.id}#key=${rsKeyCache[reverseShare.id]}`
                                        : `/share/${share.id}`
                                    }
                                    style={{ textDecoration: "none", color: "inherit" }}
                                  >
                                    <Text maw={120} truncate size="sm" sx={{ "&:hover": { textDecoration: "underline" } }}>
                                      {share.name || share.id}
                                    </Text>
                                  </Link>
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
                                  variant="light"
                                  size={25}
                                  onClick={() =>
                                    handleCopyShareLink(share.id, reverseShare)
                                  }
                                >
                                  <TbLink />
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
                                {share.description && (
                                  <Text size="xs" color="dimmed" maw={200} truncate>
                                    {share.description}
                                  </Text>
                                )}
                              </Stack>
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
                  <td>
                    {dayjs(reverseShare.shareExpiration).unix() === 0
                      ? "∞"
                      : reverseShare.remainingUses}
                  </td>
                  <td>
                    {byteToHumanSizeString(parseInt(reverseShare.maxShareSize))}
                  </td>
                  <td>
                    {dayjs(reverseShare.shareExpiration).unix() === 0
                      ? "Never"
                      : dayjs(reverseShare.shareExpiration).format("LLL")}
                  </td>
                  <td>
                    <Group position="right" spacing={4}>
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
                        variant="light"
                        size={25}
                        onClick={() => handleCopyReverseShareLink(reverseShare)}
                      >
                        <TbLink />
                      </ActionIcon>
                      <ActionIcon
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
