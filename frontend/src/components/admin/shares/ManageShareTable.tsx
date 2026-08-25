import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import { TbLock, TbShieldLock, TbTrash } from "react-icons/tb";
import useTranslate from "../../../hooks/useTranslate.hook";
import { AdminShare } from "../../../types/share.type";
import dayjs from "../../../utils/dayjs";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";

const truncateReference = (reference: string, max = 12): string =>
  reference.length > max ? `${reference.slice(0, max)}…` : reference;

const ProtectionBadge = ({ share }: { share: AdminShare }) =>
  share.isE2EEncrypted ? (
    <Badge
      color="teal"
      variant="light"
      leftSection={<TbShieldLock size={12} />}
    >
      <FormattedMessage
        id="admin.shares.protection.e2e"
        defaultMessage="End-to-end encrypted"
      />
    </Badge>
  ) : (
    <Badge color="blue" variant="light" leftSection={<TbLock size={12} />}>
      <FormattedMessage
        id="admin.shares.protection.admin-blocked"
        defaultMessage="Admin access blocked"
      />
    </Badge>
  );

const Status = ({ status }: { status: AdminShare["status"] }) => (
  <Badge variant="outline" color={status === "READY" ? "green" : "orange"}>
    {status === "READY" ? (
      <FormattedMessage id="admin.shares.status.ready" defaultMessage="Ready" />
    ) : (
      <FormattedMessage
        id="admin.shares.status.uploading"
        defaultMessage="Uploading"
      />
    )}
  </Badge>
);

const ManageShareTable = ({
  shares,
  deleteShare,
  isLoading,
}: {
  shares: AdminShare[];
  deleteShare: (_share: AdminShare) => void;
  isLoading: boolean;
}) => {
  const t = useTranslate();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const sortedShares = useMemo(
    () =>
      [...shares].sort(
        (left, right) =>
          dayjs(right.createdAt).unix() - dayjs(left.createdAt).unix(),
      ),
    [shares],
  );

  if (isMobile) {
    return (
      <Stack gap="sm">
        {isLoading
          ? [...Array(5)].map((_, index) => (
              <Card key={index} withBorder padding="sm" radius="md">
                <Skeleton height={14} mb={6} />
                <Skeleton height={10} width="60%" />
              </Card>
            ))
          : sortedShares.map((share) => (
              <Card
                key={share.reference}
                withBorder
                padding="sm"
                radius="md"
              >
                <Group justify="space-between" wrap="nowrap" mb={6}>
                  <Box style={{ minWidth: 0 }}>
                    <Tooltip label={share.reference}>
                      <Text size="sm" fw={600} ff="monospace">
                        {truncateReference(share.reference)}
                      </Text>
                    </Tooltip>
                    <Text size="xs" c="dimmed">
                      {share.creator?.username ??
                        t("admin.shares.creator.anonymous")}
                    </Text>
                  </Box>
                  <ActionIcon
                    variant="light"
                    color="red"
                    onClick={() => deleteShare(share)}
                    aria-label={t("common.button.delete")}
                  >
                    <TbTrash />
                  </ActionIcon>
                </Group>
                <Group gap="xs" mb={6}>
                  <ProtectionBadge share={share} />
                  <Status status={share.status} />
                </Group>
                <Text size="xs" c="dimmed">
                  {t("admin.shares.file-count", { count: share.fileCount })} ·{" "}
                  {byteToHumanSizeString(share.size)} ·{" "}
                  {t("admin.shares.view-count", { count: share.views })} ·{" "}
                  {dayjs(share.expiration).format("L")}
                </Text>
              </Card>
            ))}
      </Stack>
    );
  }

  return (
    <Box style={{ overflowX: "auto" }}>
      <Table striped highlightOnHover verticalSpacing="lg">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              <FormattedMessage id="admin.shares.table.audit-reference" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.shares.table.username" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.shares.table.protection" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.shares.table.status" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.shares.table.files" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="account.shares.table.size" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="account.shares.table.visitors" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="account.shares.table.expiresAt" />
            </Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {isLoading
            ? [...Array(10)].map((_, row) => (
                <Table.Tr key={row}>
                  {[...Array(9)].map((__, cell) => (
                    <Table.Td key={cell}>
                      <Skeleton height={20} />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))
            : sortedShares.map((share) => (
                <Table.Tr key={share.reference}>
                  <Table.Td>
                    <Tooltip label={share.reference}>
                      <Text size="sm" ff="monospace">
                        {truncateReference(share.reference)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    {share.creator?.username ??
                      t("admin.shares.creator.anonymous")}
                  </Table.Td>
                  <Table.Td>
                    <ProtectionBadge share={share} />
                  </Table.Td>
                  <Table.Td>
                    <Status status={share.status} />
                  </Table.Td>
                  <Table.Td>{share.fileCount}</Table.Td>
                  <Table.Td>{byteToHumanSizeString(share.size)}</Table.Td>
                  <Table.Td>{share.views}</Table.Td>
                  <Table.Td>{dayjs(share.expiration).format("LLL")}</Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="light"
                      color="red"
                      onClick={() => deleteShare(share)}
                      aria-label={t("common.button.delete")}
                    >
                      <TbTrash />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
};

export default ManageShareTable;
