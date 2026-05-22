import {
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Space,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "../../utils/dayjs";
import Link from "next/link";
import { TbCopy, TbEdit, TbInfoCircle, TbLock, TbQrcode, TbSignature, TbTrash } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import { useState } from "react";
import Meta from "../../components/Meta";
import RequestSignatureModal from "../../components/signing/RequestSignatureModal";
import showShareInformationsModal from "../../components/account/showShareInformationsModal";
import showShareLinkModal from "../../components/account/showShareLinkModal";
import showQrCodeModal from "../../components/core/showQrCodeModal";
import CenterLoader from "../../components/core/CenterLoader";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import shareService from "../../services/share.service";
import { MyShare } from "../../types/share.type";
import { copyToClipboard } from "../../utils/clipboard.util";
import toast from "../../utils/toast.util";
import { getUserKey, buildKeyFragment } from "../../utils/crypto.util";

const MyShares = () => {
  const modals = useModals();
  const config = useConfig();
  const t = useTranslate();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const { user } = useUser();
  const isTeamPlan = user?.plan === "TEAM" || user?.hasTeamMembership;

  const {
    data: shares,
    isLoading,
    isError,
    refetch,
  } = useQuery<MyShare[]>({
    queryKey: ["myShares"],
    queryFn: shareService.getMyShares,
  });

  const deleteShareMutation = useMutation({
    mutationFn: (shareId: string) => shareService.remove(shareId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myShares"] });
      toast.success(t("account.shares.notify.deleted-success"));
    },
    onError: () => {
      toast.error(t("account.shares.notify.delete-fail"));
    },
  });

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (!shares) return;
    if (selected.size === shares.length) setSelected(new Set());
    else setSelected(new Set(shares.map((s) => s.id)));
  };

  // Signature request modal
  const [sigModalShare, setSigModalShare] = useState<{ id: string; files: { id: string; name: string }[]; isE2E: boolean } | null>(null);
  const bulkDelete = () => {
    if (selected.size === 0) return;
    const count = selected.size;
    modals.openConfirmModal({
      title: t("account.shares.bulk-delete.title", { count }),
      children: (
        <Text size="sm">
          <FormattedMessage id="account.shares.bulk-delete.description" values={{ count }} />
        </Text>
      ),
      labels: { confirm: t("common.button.delete"), cancel: t("common.button.cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        selected.forEach((id) => deleteShareMutation.mutate(id));
        setSelected(new Set());
      },
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

  if (isLoading || !shares) return <CenterLoader />;

  return (
    <>
      <Meta title={t("account.shares.title")} />
      <Title mb={30} order={3}>
        <FormattedMessage id="account.shares.title" />
      </Title>
      {shares.length == 0 ? (
        <Center style={{ height: "70vh" }}>
          <Stack align="center" gap={10}>
            <Title order={3}>
              <FormattedMessage id="account.shares.title.empty" />
            </Title>
            <Text>
              <FormattedMessage id="account.shares.description.empty" />
            </Text>
            <Space h={5} />
            <Button component={Link} href="/upload" variant="light">
              <FormattedMessage id="account.shares.button.create" />
            </Button>
          </Stack>
        </Center>
      ) : isMobile ? (
        /* --- Mobile: card layout --- */
        <Stack gap="sm">
          {shares.length > 0 && (
            <Group justify="space-between">
              <Checkbox
                label={t("account.shares.select-all")}
                checked={selected.size === shares.length}
                indeterminate={selected.size > 0 && selected.size < shares.length}
                onChange={toggleAll}
              />
              {selected.size > 0 && (
                <Button size="compact-sm" color="red" variant="light" leftSection={<TbTrash size={16} />} onClick={bulkDelete}>
                  <FormattedMessage id="account.shares.bulk-delete.button" values={{ count: selected.size }} />
                </Button>
              )}
            </Group>
          )}
          {shares.map((share) => {
            // For team shares the encryption key is K_team, not K_master.
            // Don't inject master key in the hash — Phase 2 on the share page
            // will resolve the correct team key via getTeamKey().
            const storedKey =
              share.isE2EEncrypted && !share.teamFolderId
                ? getUserKey()
                : null;
            const keyFragment = storedKey ? buildKeyFragment(storedKey) : "";
            const shareHref = `/share/${share.id}${keyFragment}`;
            return (
              <Card key={share.id} withBorder padding="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" mb={4}>
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                    <Checkbox
                      size="xs"
                      checked={selected.has(share.id)}
                      onChange={() => toggleSelect(share.id)}
                    />
                    <Box style={{ minWidth: 0, flex: 1 }}>
                    <Link href={shareHref} style={{ textDecoration: "none", color: "inherit" }}>
                      <Text size="sm" fw={600} lineClamp={1} style={{ cursor: "pointer" }}>
                        {share.name || share.id}
                      </Text>
                    </Link>
                    {share.description && (
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {share.description}
                      </Text>
                    )}
                  </Box>                  </Group>                  {share.security.passwordProtected && (
                    <TbLock color="orange" size={16} />
                  )}
                </Group>

                <Group gap="xs" mb={8}>
                  <Text size="xs" c="dimmed">
                    <FormattedMessage id="account.shares.table.visitors" />: {share.security.maxViews ? `${share.views}/${share.security.maxViews}` : share.views}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {dayjs(share.expiration).unix() === 0
                      ? t("account.shares.table.expiry-never")
                      : `${t("account.shares.table.expiresAt")} ${dayjs(share.expiration).format("L")}`}
                  </Text>
                </Group>

                <Group gap={6}>
                  <Link href={`/share/${share.id}/edit`}>
                    <ActionIcon color="blue" variant="light" size={28}>
                      <TbEdit />
                    </ActionIcon>
                  </Link>
                  <ActionIcon color="blue" variant="light" size={28}
                    onClick={() => showShareInformationsModal(modals, share, parseInt(config.get("share.maxSize")))}
                  >
                    <TbInfoCircle />
                  </ActionIcon>
                  <ActionIcon color="teal" variant="light" size={28}
                    onClick={async () => {
                      const sk = share.isE2EEncrypted ? getUserKey() : null;
                      const kf = sk ? buildKeyFragment(sk) : "";
                      const link = `${config.get("general.appUrl")}/s/${share.id}${kf}`;
                      const ok = await copyToClipboard(link);
                      if (ok) toast.success(t("common.notify.copied-link"));
                      else showShareLinkModal(modals, share.id, kf);
                    }}
                  >
                    <TbCopy />
                  </ActionIcon>
                  <ActionIcon color="grape" variant="light" size={28}
                    onClick={() => {
                      const sk = share.isE2EEncrypted ? getUserKey() : null;
                      const kf = sk ? buildKeyFragment(sk) : "";
                      showQrCodeModal(modals, `${config.get("general.appUrl")}/s/${share.id}${kf}`);
                    }}
                  >
                    <TbQrcode />
                  </ActionIcon>
                  {isTeamPlan && (share.files || []).some((f: any) => /\.pdf$/i.test(f.name || "")) && (
                    <ActionIcon color="violet" variant="light" size={28}
                      onClick={() => {
                        const fileList = (share.files || [])
                          .filter((f: any) => /\.pdf$/i.test(f.name || ""))
                          .map((f: any) => ({ id: f.id, name: f.name || f.id }));
                        setSigModalShare({ id: share.id, files: fileList, isE2E: !!share.isE2EEncrypted });
                      }}
                    >
                      <TbSignature />
                    </ActionIcon>
                  )}
                  <ActionIcon color="red" variant="light" size={28}
                    onClick={() => {
                      modals.openConfirmModal({
                        title: t("account.shares.modal.delete.title", { share: share.id }),
                        children: <Text size="sm"><FormattedMessage id="account.shares.modal.delete.description" /></Text>,
                        confirmProps: { color: "red" },
                        labels: { confirm: t("common.button.delete"), cancel: t("common.button.cancel") },
                        onConfirm: () => deleteShareMutation.mutate(share.id),
                      });
                    }}
                  >
                    <TbTrash />
                  </ActionIcon>
                </Group>
              </Card>
            );
          })}
        </Stack>
      ) : (
        /* --- Desktop: table layout --- */
        <>
          {selected.size > 0 && (
            <Group mb="sm">
              <Button size="compact-sm" color="red" variant="light" leftSection={<TbTrash size={16} />} onClick={bulkDelete}>
                <FormattedMessage id="account.shares.bulk-delete.button" values={{ count: selected.size }} />
              </Button>
            </Group>
          )}
          <Box style={{ display: "block", overflowX: "auto" }}>
          <Table striped highlightOnHover withRowBorders verticalSpacing="lg" style={{ tableLayout: "fixed" }}>
            <Table.Thead style={{ textAlign: "left" }}>
              <Table.Tr>
                <Table.Th style={{ width: "3%" }}>
                  <Checkbox
                    size="xs"
                    checked={selected.size === shares.length && shares.length > 0}
                    indeterminate={selected.size > 0 && selected.size < shares.length}
                    onChange={toggleAll}
                  />
                </Table.Th>
                <Table.Th style={{ width: "37%" }}>
                  <FormattedMessage id="account.shares.table.name" />
                </Table.Th>
                <Table.Th style={{ width: "12%" }}>
                  <FormattedMessage id="account.shares.table.visitors" />
                </Table.Th>
                <Table.Th style={{ whiteSpace: "nowrap", width: "22%" }}>
                  <FormattedMessage id="account.shares.table.expiresAt" />
                </Table.Th>
                <Table.Th style={{ width: "26%" }}></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shares.map((share) => {
                const storedKey = share.isE2EEncrypted
                  ? getUserKey()
                  : null;
                const keyFragment = storedKey
                  ? buildKeyFragment(storedKey)
                  : "";
                const shareHref = `/share/${share.id}${keyFragment}`;
                return (
                <Table.Tr key={share.id}>
                  <Table.Td>
                    <Checkbox
                      size="xs"
                      checked={selected.has(share.id)}
                      onChange={() => toggleSelect(share.id)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Box style={{ minWidth: 0 }}>
                        <Link href={shareHref} style={{ textDecoration: "none", color: "inherit" }}>
                          <Text size="sm" fw={500} lineClamp={1} style={{ cursor: "pointer" }}>
                            {share.name || share.id}
                          </Text>
                        </Link>
                        {share.description && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {share.description}
                          </Text>
                        )}
                        {share.name && (
                          <Text size="xs" c="dimmed">
                            {share.id}
                          </Text>
                        )}
                    </Box>
                  </Table.Td>
                  <Table.Td>
                    {share.security.maxViews ? (
                      <FormattedMessage
                        id="account.shares.table.visitor-count"
                        values={{
                          count: share.views,
                          max: share.security.maxViews,
                        }}
                      />
                    ) : (
                      share.views
                    )}
                  </Table.Td>
                  <Table.Td>
                    {dayjs(share.expiration).unix() === 0 ? (
                      <FormattedMessage id="account.shares.table.expiry-never" />
                    ) : (
                      dayjs(share.expiration).format("LLL")
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group justify="right" gap={6} wrap="nowrap">
                      {share.security.passwordProtected && (
                        <Tooltip label={t("account.shares.table.password-protected")}>
                          <ThemeIcon color="orange" variant="light" size={25}>
                            <TbLock size={14} />
                          </ThemeIcon>
                        </Tooltip>
                      )}
                      <Link href={`/share/${share.id}/edit`}>
                        <ActionIcon color="blue" variant="light" size={25}>
                          <TbEdit />
                        </ActionIcon>
                      </Link>
                      <ActionIcon
                        color="blue"
                        variant="light"
                        size={25}
                        onClick={() => {
                          showShareInformationsModal(
                            modals,
                            share,
                            parseInt(config.get("share.maxSize")),
                          );
                        }}
                      >
                        <TbInfoCircle />
                      </ActionIcon>
                      <ActionIcon
                        color="teal"
                        variant="light"
                        size={25}
                        onClick={async () => {
                          const storedKey = share.isE2EEncrypted
                            ? getUserKey()
                            : null;
                          const keyFragment = storedKey
                            ? buildKeyFragment(storedKey)
                            : "";
                          const link = `${config.get("general.appUrl")}/s/${share.id}${keyFragment}`;
                          const ok = await copyToClipboard(link);
                          if (ok) {
                            toast.success(t("common.notify.copied-link"));
                          } else {
                            showShareLinkModal(modals, share.id, keyFragment);
                          }
                        }}
                      >
                        <TbCopy />
                      </ActionIcon>
                      <ActionIcon
                        color="grape"
                        variant="light"
                        size={25}
                        onClick={() => {
                          const storedKey = share.isE2EEncrypted
                            ? getUserKey()
                            : null;
                          const keyFragment = storedKey
                            ? buildKeyFragment(storedKey)
                            : "";
                          const link = `${config.get("general.appUrl")}/s/${share.id}${keyFragment}`;
                          showQrCodeModal(modals, link);
                        }}
                      >
                        <TbQrcode />
                      </ActionIcon>
                      <Tooltip label={t("signing.modal.title")}>
                        <ActionIcon
                          color="violet"
                          variant="light"
                          size={25}
                          style={{
                            display: isTeamPlan && (share.files || []).some((f: any) => /\.pdf$/i.test(f.name || ""))
                              ? undefined
                              : "none",
                          }}
                          onClick={() => {
                            const fileList = (share.files || [])
                              .filter((f: any) => /\.pdf$/i.test(f.name || ""))
                              .map((f: any) => ({ id: f.id, name: f.name || f.id }));
                            setSigModalShare({ id: share.id, files: fileList, isE2E: !!share.isE2EEncrypted });
                          }}
                        >
                          <TbSignature />
                        </ActionIcon>
                      </Tooltip>
                      <ActionIcon
                        color="red"
                        variant="light"
                        size={25}
                        onClick={() => {
                          modals.openConfirmModal({
                            title: t("account.shares.modal.delete.title", {
                              share: share.id,
                            }),
                            children: (
                              <Text size="sm">
                                <FormattedMessage id="account.shares.modal.delete.description" />
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
                              deleteShareMutation.mutate(share.id),
                          });
                        }}
                      >
                        <TbTrash />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Box>
        </>
      )}

      {/* Signature request modal */}
      {sigModalShare && (
        <RequestSignatureModal
          opened={!!sigModalShare}
          onClose={() => setSigModalShare(null)}
          shareId={sigModalShare.id}
          files={sigModalShare.files}
          encryptionKey={sigModalShare.isE2E ? getUserKey() : null}
        />
      )}
    </>
  );
};

export default MyShares;
