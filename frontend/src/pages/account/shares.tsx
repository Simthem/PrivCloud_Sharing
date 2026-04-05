import {
  ActionIcon,
  Box,
  Button,
  Center,
  Group,
  Space,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "../../utils/dayjs";
import Link from "next/link";
import { TbEdit, TbInfoCircle, TbLink, TbLock, TbQrcode, TbTrash } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
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
      ) : (
        <Box sx={{ display: "block", overflowX: "auto" }}>
          <Table>
            <thead>
              <tr>
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
              {shares.map((share) => (
                <tr key={share.id}>
                  <td>
                    <Group spacing="xs" noWrap>
                      <Box>
                        <Text size="sm" weight={500} lineClamp={1}>
                          {share.name || share.id}
                        </Text>
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
                      {share.security.passwordProtected && (
                        <TbLock
                          color="orange"
                          title={t("account.shares.table.password-protected")}
                        />
                      )}
                    </Group>
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
                    <Group position="right">
                      <Link href={`/share/${share.id}/edit`}>
                        <ActionIcon color="orange" variant="light" size={25}>
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
                        <TbLink />
                      </ActionIcon>
                      <ActionIcon
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
              ))}
            </tbody>
          </Table>
        </Box>
      )}
    </>
  );
};

export default MyShares;
