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
import { TbCopy, TbEdit, TbInfoCircle, TbLock, TbQrcode, TbTrash } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import { useState } from "react";
import Meta from "../../components/Meta";
import showShareInformationsModal from "../../components/account/showShareInformationsModal";
import showShareLinkModal from "../../components/account/showShareLinkModal";
import showQrCodeModal from "../../components/core/showQrCodeModal";
import CenterLoader from "../../components/core/CenterLoader";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
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
          <Stack align="center" spacing={10}>
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
        /* Mobile: card layout */
        <Stack spacing="sm">
          {shares.length > 0 && (
            <Group position="apart">
              <Checkbox
                label={t("account.shares.select-all")}
                checked={selected.size === shares.length}
                indeterminate={selected.size > 0 && selected.size < shares.length}
                onChange={toggleAll}
              />
              {selected.size > 0 && (
                <Button size="xs" compact color="red" variant="light" leftIcon={<TbTrash size={16} />} onClick={bulkDelete}>
                  <FormattedMessage id="account.shares.bulk-delete.button" values={{ count: selected.size }} />
                </Button>
              )}
            </Group>
          )}
          {shares.map((share) => {
            const storedKey = share.isE2EEncrypted ? getUserKey() : null;
            const keyFragment = storedKey ? buildKeyFragment(storedKey) : "";
            const shareHref = `/share/${share.id}${keyFragment}`;
            return (
              <Card key={share.id} withBorder padding="sm" radius="md">
                <Group position="apart" noWrap mb={4}>
                  <Group spacing="xs" noWrap style={{ minWidth: 0, flex: 1 }}>
                    <Checkbox
                      size="xs"
                      checked={selected.has(share.id)}
                      onChange={() => toggleSelect(share.id)}
                    />
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Link href={shareHref} style={{ textDecoration: "none", color: "inherit" }}>
                        <Text size="sm" weight={600} lineClamp={1} sx={{ "&:hover": { textDecoration: "underline" } }}>
                          {share.name || share.id}
                        </Text>
                      </Link>
                      {share.description && (
                        <Text size="xs" color="dimmed" lineClamp={1}>
                          {share.description}
                        </Text>
                      )}
                    </Box>
                  </Group>
                  {share.security.passwordProtected && (
                    <TbLock color="orange" size={16} />
                  )}
                </Group>

                <Group spacing="xs" mb={8}>
                  <Text size="xs" color="dimmed">
                    <FormattedMessage id="account.shares.table.visitors" />: {share.security.maxViews ? `${share.views}/${share.security.maxViews}` : share.views}
                  </Text>
                  <Text size="xs" color="dimmed">
                    {dayjs(share.expiration).unix() === 0
                      ? t("account.shares.table.expiry-never")
                      : `${t("account.shares.table.expiresAt")} ${dayjs(share.expiration).format("L")}`}
                  </Text>
                </Group>

                <Group spacing={6}>
                  <Link href={`/share/${share.id}/edit`}>
                    <ActionIcon color="orange" variant="light" size={28}>
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
        /* Desktop: table layout */
        <>
          {selected.size > 0 && (
            <Group mb="sm">
              <Button size="xs" compact color="red" variant="light" leftIcon={<TbTrash size={16} />} onClick={bulkDelete}>
                <FormattedMessage id="account.shares.bulk-delete.button" values={{ count: selected.size }} />
              </Button>
            </Group>
          )}
          <Box sx={{ display: "block", overflowX: "auto" }}>
          <Table striped highlightOnHover verticalSpacing="lg">
            <thead>
              <tr>
                <th style={{ width: "3%" }}>
                  <Checkbox
                    size="xs"
                    checked={selected.size === shares.length && shares.length > 0}
                    indeterminate={selected.size > 0 && selected.size < shares.length}
                    onChange={toggleAll}
                  />
                </th>
                <th>
                  <FormattedMessage id="account.shares.table.name" />
                </th>
                <th>
                  <FormattedMessage id="account.shares.table.visitors" />
                </th>
                <th>
                  <FormattedMessage id="account.shares.table.expiresAt" />
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shares.map((share) => {
                const storedKey = share.isE2EEncrypted
                  ? getUserKey()
                  : null;
                const keyFragment = storedKey
                  ? buildKeyFragment(storedKey)
                  : "";
                const shareHref = `/share/${share.id}${keyFragment}`;
                return (
                <tr key={share.id}>
                  <td>
                    <Checkbox
                      size="xs"
                      checked={selected.has(share.id)}
                      onChange={() => toggleSelect(share.id)}
                    />
                  </td>
                  <td>
                    <Box style={{ minWidth: 0 }}>
                        <Link href={shareHref} style={{ textDecoration: "none", color: "inherit" }}>
                          <Text size="sm" weight={500} lineClamp={1} sx={{ "&:hover": { textDecoration: "underline" } }}>
                            {share.name || share.id}
                          </Text>
                        </Link>
                        {share.description && (
                          <Text size="xs" color="dimmed" lineClamp={1}>
                            {share.description}
                          </Text>
                        )}
                        {share.name && (
                          <Text size="xs" color="dimmed">
                            {share.id}
                          </Text>
                        )}
                    </Box>
                  </td>
                  <td>
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
                  </td>
                  <td>
                    {dayjs(share.expiration).unix() === 0 ? (
                      <FormattedMessage id="account.shares.table.expiry-never" />
                    ) : (
                      dayjs(share.expiration).format("LLL")
                    )}
                  </td>
                  <td>
                    <Group position="right" spacing={6} noWrap>
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
                  </td>
                </tr>
                );
              })}
            </tbody>
          </Table>
        </Box>
        </>
      )}
    </>
  );
};

export default MyShares;
