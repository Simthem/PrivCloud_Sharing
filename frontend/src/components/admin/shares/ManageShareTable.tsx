import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { useEffect, useMemo, useState } from "react";
import { TbLock, TbShieldLock, TbTrash } from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import useTranslate from "../../../hooks/useTranslate.hook";
import SortableHeader, { SortDirection } from "../SortableHeader";
import { AdminShare } from "../../../types/share.type";
import dayjs from "../../../utils/dayjs";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";

import {
  formatShareExpiration,
  isShareExpired,
} from "../../../utils/shareExpiration.util";

type SortField = "reference" | "size" | "date" | null;

const truncateReference = (reference: string, max = 12): string =>
  reference.length > max ? `${reference.slice(0, max)}...` : reference;

const ProtectionBadge = ({ share }: { share: AdminShare }) =>
  share.isE2EEncrypted ? (
    <Badge
      color="teal"
      variant="light"
      leftSection={<TbShieldLock size={12} />}
      style={{
        flexShrink: 0,
        maxWidth: "none",
        whiteSpace: "normal",
        height: "auto",
        minHeight: 20,
      }}
    >
      <FormattedMessage
        id="admin.shares.protection.e2e"
        defaultMessage="End-to-end encrypted"
      />
    </Badge>
  ) : (
    <Badge
      color="blue"
      variant="light"
      leftSection={<TbLock size={12} />}
      style={{
        flexShrink: 0,
        maxWidth: "none",
        whiteSpace: "normal",
        height: "auto",
        minHeight: 20,
      }}
    >
      <FormattedMessage
        id="admin.shares.protection.admin-blocked"
        defaultMessage="Admin access blocked"
      />
    </Badge>
  );

const StatusBadge = ({ status }: { status: AdminShare["status"] }) => (
  <Badge
    color={
      status === "EXPIRED" ? "red" : status === "READY" ? "teal" : "yellow"
    }
    variant="outline"
    styles={{
      label: {
        whiteSpace: "normal",
        overflow: "visible",
        textOverflow: "clip",
      },
    }}
    style={{
      flexShrink: 0,
      maxWidth: "none",
      whiteSpace: "normal",
      height: "auto",
      minHeight: 20,
    }}
  >
    {status === "EXPIRED" ? (
      <FormattedMessage
        id="admin.shares.status.expired"
        defaultMessage="Expired"
      />
    ) : status === "READY" ? (
      <FormattedMessage id="admin.shares.status.ready" defaultMessage="Ready" />
    ) : (
      <FormattedMessage
        id={
          status === "INACTIVE"
            ? "admin.shares.status.inactive"
            : "admin.shares.status.unfinished"
        }
        defaultMessage={
          status === "INACTIVE" ? "Inactive upload" : "Not finalized"
        }
      />
    )}
  </Badge>
);

const ShareExpiration = ({
  expiration,
}: {
  expiration: AdminShare["expiration"];
}) => {
  const { locale } = useIntl();
  const t = useTranslate();
  if (new Date(expiration).getTime() === 0) {
    return <Text size="sm">{t("account.shares.table.expiry-never")}</Text>;
  }
  const formatted = formatShareExpiration(expiration, locale);
  return (
    <Stack gap={0} style={{ whiteSpace: "nowrap" }}>
      <Text component="time" dateTime={formatted.iso} size="sm">
        {formatted.date}
      </Text>
      <Text size="xs" c="dimmed">
        {formatted.time}
      </Text>
    </Stack>
  );
};

const readableCellStyle = {
  overflowWrap: "normal" as const,
  wordBreak: "normal" as const,
};

const ManageShareTable = ({
  shares,
  deleteShare,
  isLoading,
}: {
  shares: AdminShare[];
  deleteShare: (_share: AdminShare) => void;
  isLoading: boolean;
}) => {
  const modals = useModals();
  const t = useTranslate();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    const nextExpiration = Math.min(
      ...shares
        .map((share) => new Date(share.expiration).getTime())
        .filter((timestamp) => timestamp > now),
    );
    const timer = Number.isFinite(nextExpiration)
      ? window.setTimeout(
          update,
          Math.min(Math.max(0, nextExpiration - Date.now()) + 1, 2_147_483_647),
        )
      : undefined;
    window.addEventListener("focus", update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", update);
    };
  }, [shares, now]);
  const statusFor = (share: AdminShare): AdminShare["status"] =>
    isShareExpired(share.expiration, now) ? "EXPIRED" : share.status;
  const isMobile = useMediaQuery("(max-width: 680px)");
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sortedShares = useMemo(() => {
    if (!sortField) return shares;
    const direction = sortDir === "asc" ? 1 : -1;
    return [...shares].sort((a, b) => {
      if (sortField === "reference") {
        return direction * a.reference.localeCompare(b.reference);
      }
      if (sortField === "size") return direction * (a.size - b.size);
      return (
        direction * (dayjs(a.expiration).unix() - dayjs(b.expiration).unix())
      );
    });
  }, [shares, sortField, sortDir]);

  const toggleSelect = (reference: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(reference)) next.delete(reference);
      else next.add(reference);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((previous) =>
      previous.size === sortedShares.length
        ? new Set()
        : new Set(sortedShares.map(({ reference }) => reference)),
    );
  };

  const bulkDelete = () => {
    if (selected.size === 0) return;
    const count = selected.size;
    modals.openConfirmModal({
      title: t("admin.shares.bulk-delete.title", { count }),
      children: (
        <Text size="sm">
          <FormattedMessage
            id="admin.shares.bulk-delete.description"
            values={{ count }}
          />
        </Text>
      ),
      labels: {
        confirm: t("common.button.delete"),
        cancel: t("common.button.cancel"),
      },
      confirmProps: { color: "red" },
      onConfirm: () => {
        sortedShares
          .filter(({ reference }) => selected.has(reference))
          .forEach(deleteShare);
        setSelected(new Set());
      },
    });
  };

  const selectionControls = selected.size > 0 && (
    <Button
      size="compact-sm"
      color="red"
      variant="light"
      leftSection={<TbTrash size={16} />}
      onClick={bulkDelete}
    >
      <FormattedMessage
        id="admin.shares.bulk-delete.button"
        values={{ count: selected.size }}
      />
    </Button>
  );

  if (isMobile) {
    return (
      <Stack gap="sm">
        {!isLoading && sortedShares.length > 0 && (
          <Group justify="space-between">
            <Checkbox
              label={t("admin.shares.select-all")}
              checked={
                selected.size === sortedShares.length && sortedShares.length > 0
              }
              indeterminate={
                selected.size > 0 && selected.size < sortedShares.length
              }
              onChange={toggleAll}
            />
            {selectionControls}
          </Group>
        )}
        {isLoading
          ? [...Array(5)].map((_, index) => (
              <Card key={index} withBorder padding="sm" radius="md">
                <Skeleton height={14} mb={6} />
                <Skeleton height={10} width="60%" />
              </Card>
            ))
          : sortedShares.map((share) => (
              <Card key={share.reference} withBorder padding="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" mb={6}>
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                    <Checkbox
                      size="xs"
                      checked={selected.has(share.reference)}
                      onChange={() => toggleSelect(share.reference)}
                    />
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600} ff="monospace">
                        {truncateReference(share.reference)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {share.creator?.username ?? "Anonymous"}
                      </Text>
                    </Box>
                  </Group>
                  <ActionIcon
                    variant="light"
                    color="red"
                    size={28}
                    onClick={() => deleteShare(share)}
                    aria-label={t("common.button.delete")}
                  >
                    <TbTrash />
                  </ActionIcon>
                </Group>
                <Group gap="xs" mb={6}>
                  <ProtectionBadge share={share} />
                  <StatusBadge status={statusFor(share)} />
                </Group>
                <Text size="xs" c="dimmed">
                  {share.fileCount} file(s) ·{" "}
                  {byteToHumanSizeString(share.size)} · {share.views} view(s)
                </Text>
                <ShareExpiration expiration={share.expiration} />
              </Card>
            ))}
      </Stack>
    );
  }

  return (
    <>
      {selectionControls && <Group mb="sm">{selectionControls}</Group>}
      <Box
        style={{
          display: "block",
          overflowX: "auto",
          border: "1px solid var(--mantine-color-default-border)",
          borderRadius: "var(--mantine-radius-md)",
        }}
      >
        <Table
          striped
          highlightOnHover
          horizontalSpacing="sm"
          verticalSpacing="md"
          styles={{
            th: { ...readableCellStyle, whiteSpace: "nowrap" },
            td: readableCellStyle,
          }}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <Group gap="sm" wrap="nowrap">
                  <Checkbox
                    size="xs"
                    aria-label={t("admin.shares.select-all")}
                    checked={
                      selected.size === sortedShares.length &&
                      sortedShares.length > 0
                    }
                    indeterminate={
                      selected.size > 0 && selected.size < sortedShares.length
                    }
                    onChange={toggleAll}
                  />
                  <SortableHeader
                    field="reference"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  >
                    <FormattedMessage
                      id="admin.shares.table.reference"
                      defaultMessage="Audit reference"
                    />
                  </SortableHeader>
                </Group>
              </Table.Th>
              <Table.Th>
                <FormattedMessage id="admin.shares.table.username" />
              </Table.Th>
              <Table.Th>
                <FormattedMessage
                  id="admin.shares.table.protection"
                  defaultMessage="Protection"
                />
              </Table.Th>
              <Table.Th>
                <FormattedMessage
                  id="admin.shares.table.status"
                  defaultMessage="Status"
                />
              </Table.Th>
              <Table.Th>
                <FormattedMessage
                  id="admin.shares.table.files"
                  defaultMessage="Files"
                />
              </Table.Th>
              <Table.Th>
                <SortableHeader
                  field="size"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                >
                  <FormattedMessage id="account.shares.table.size" />
                </SortableHeader>
              </Table.Th>
              <Table.Th>
                <FormattedMessage id="account.shares.table.visitors" />
              </Table.Th>
              <Table.Th>
                <SortableHeader
                  field="date"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                >
                  <FormattedMessage id="account.shares.table.expiresAt" />
                </SortableHeader>
              </Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading
              ? skeletonRows
              : sortedShares.map((share) => (
                  <Table.Tr key={share.reference}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <Checkbox
                          size="xs"
                          aria-label={`${t("admin.shares.select-all")} ${truncateReference(share.reference)}`}
                          checked={selected.has(share.reference)}
                          onChange={() => toggleSelect(share.reference)}
                        />
                        <Tooltip label={share.reference}>
                          <Text
                            size="sm"
                            ff="monospace"
                            style={{ whiteSpace: "nowrap" }}
                          >
                            {truncateReference(share.reference)}
                          </Text>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {share.creator?.username ?? (
                        <Text c="dimmed">Anonymous</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <ProtectionBadge share={share} />
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={statusFor(share)} />
                    </Table.Td>
                    <Table.Td>{share.fileCount}</Table.Td>
                    <Table.Td>{byteToHumanSizeString(share.size)}</Table.Td>
                    <Table.Td>{share.views}</Table.Td>
                    <Table.Td>
                      <ShareExpiration expiration={share.expiration} />
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        variant="light"
                        color="red"
                        size={25}
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
    </>
  );
};

const skeletonRows = [...Array(10)].map((_, index) => (
  <Table.Tr key={index}>
    {[...Array(9)].map((__, cell) => (
      <Table.Td key={cell}>
        <Skeleton height={20} />
      </Table.Td>
    ))}
  </Table.Tr>
));

export default ManageShareTable;
