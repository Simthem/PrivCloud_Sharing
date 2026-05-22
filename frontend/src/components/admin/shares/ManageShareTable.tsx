import {
  ActionIcon,
  Box,
  Card,
  Checkbox,
  Group,
  Button,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import dayjs from "../../../utils/dayjs";
import { useState, useMemo } from "react";
import { TbLink, TbTrash, TbArrowUp, TbArrowDown, TbArrowsSort } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import useConfig from "../../../hooks/config.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import { MyShare } from "../../../types/share.type";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";
import { copyToClipboard } from "../../../utils/clipboard.util";
import toast from "../../../utils/toast.util";
import showShareLinkModal from "../../account/showShareLinkModal";

type SortField = "name" | "size" | "date" | null;
type SortDir = "asc" | "desc";

const SortableHeader = ({
  field,
  currentField,
  currentDir,
  onSort,
  children,
}: {
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (_f: SortField) => void;
  children: React.ReactNode;
}) => {
  const Icon =
    currentField === field
      ? currentDir === "asc"
        ? TbArrowUp
        : TbArrowDown
      : TbArrowsSort;
  return (
    <UnstyledButton onClick={() => onSort(field)} style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <Text fw={700} size="sm">{children}</Text>
      <Icon size={14} />
    </UnstyledButton>
  );
};

const truncateId = (id: string, max = 12): string =>
  id.length > max ? id.slice(0, max) + "…" : id;

const ManageShareTable = ({
  shares,
  deleteShare,
  isLoading,
}: {
  shares: MyShare[];
  deleteShare: (_share: MyShare) => void;
  isLoading: boolean;
}) => {
  const modals = useModals();
  const config = useConfig();
  const t = useTranslate();
  const isMobile = useMediaQuery("(max-width: 680px)");

  // Sorting
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sortedShares = useMemo(() => {
    if (!sortField) return shares;
    const arr = [...shares];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortField) {
        case "name":
          return dir * (a.name || a.id).localeCompare(b.name || b.id);
        case "size":
          return dir * (a.size - b.size);
        case "date":
          return dir * (dayjs(a.expiration).unix() - dayjs(b.expiration).unix());
        default:
          return 0;
      }
    });
    return arr;
  }, [shares, sortField, sortDir]);

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
    if (selected.size === sortedShares.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedShares.map((s) => s.id)));
    }
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
          .filter((s) => selected.has(s.id))
          .forEach((s) => deleteShare(s));
        setSelected(new Set());
      },
    });
  };

  const copyLink = async (shareId: string) => {
    const link = `${config.get("general.appUrl")}/s/${shareId}`;
    const ok = await copyToClipboard(link);
    if (ok) {
      toast.success(t("common.notify.copied-link"));
    } else {
      showShareLinkModal(modals, shareId);
    }
  };

  if (isMobile) {
    return (
      <Stack gap="sm">
        {!isLoading && sortedShares.length > 0 && (
          <Group justify="space-between">
            <Checkbox
              label={t("admin.shares.select-all")}
              checked={selected.size === sortedShares.length && sortedShares.length > 0}
              indeterminate={selected.size > 0 && selected.size < sortedShares.length}
              onChange={toggleAll}
            />
            {selected.size > 0 && (
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
            )}
          </Group>
        )}
        {isLoading
          ? [...Array(5)].map((_, i) => (
              <Card key={i} withBorder padding="sm" radius="md">
                <Skeleton height={14} mb={6} />
                <Skeleton height={10} width="60%" />
              </Card>
            ))
          : sortedShares.map((share) => (
              <Card key={share.id} withBorder padding="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" mb={4}>
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                    <Checkbox
                      size="xs"
                      checked={selected.has(share.id)}
                      onChange={() => toggleSelect(share.id)}
                    />
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Text size="sm" fw={600} lineClamp={1}>
                        {share.name || truncateId(share.id)}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {share.creator ? share.creator.username : "Anonymous"}
                      </Text>
                    </Box>
                  </Group>
                  <Group gap={6} wrap="nowrap">
                    <ActionIcon
                      variant="light"
                      color="teal"
                      size={28}
                      onClick={() => copyLink(share.id)}
                    >
                      <TbLink />
                    </ActionIcon>
                    <ActionIcon
                      variant="light"
                      color="red"
                      size={28}
                      onClick={() => deleteShare(share)}
                    >
                      <TbTrash />
                    </ActionIcon>
                  </Group>
                </Group>
                <Group gap="xs">
                  <Text size="xs" c="dimmed">
                    {byteToHumanSizeString(share.size)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    ·
                  </Text>
                  <Text size="xs" c="dimmed">
                    {share.views} <FormattedMessage id="account.shares.table.visitors" />
                  </Text>
                  <Text size="xs" c="dimmed">
                    ·
                  </Text>
                  <Text size="xs" c="dimmed">
                    {dayjs(share.expiration).unix() === 0
                      ? "Never"
                      : dayjs(share.expiration).format("L")}
                  </Text>
                </Group>
              </Card>
            ))}
      </Stack>
    );
  }

  return (
    <>
      {selected.size > 0 && (
        <Group mb="sm">
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
        </Group>
      )}
      <Box style={{ display: "block", overflowX: "auto" }}>
        <Table striped highlightOnHover withRowBorders verticalSpacing="lg" style={{ tableLayout: "fixed" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: "3%" }}>
                <Checkbox
                  size="xs"
                  checked={selected.size === sortedShares.length && sortedShares.length > 0}
                  indeterminate={selected.size > 0 && selected.size < sortedShares.length}
                  onChange={toggleAll}
                />
              </Table.Th>
              <Table.Th style={{ textAlign: "left", width: "14%" }}>
                <FormattedMessage id="account.shares.table.id" />
              </Table.Th>
              <Table.Th style={{ textAlign: "left", width: "18%" }}>
                <SortableHeader field="name" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                  <FormattedMessage id="account.shares.table.name" />
                </SortableHeader>
              </Table.Th>
              <Table.Th style={{ textAlign: "left", width: "13%" }}>
                <FormattedMessage id="admin.shares.table.username" />
              </Table.Th>
              <Table.Th style={{ textAlign: "left", width: "8%" }}>
                <FormattedMessage id="account.shares.table.visitors" />
              </Table.Th>
              <Table.Th style={{ textAlign: "left", width: "10%" }}>
                <SortableHeader field="size" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                  <FormattedMessage id="account.shares.table.size" />
                </SortableHeader>
              </Table.Th>
              <Table.Th style={{ textAlign: "left", width: "18%" }}>
                <SortableHeader field="date" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                  <FormattedMessage id="account.shares.table.expiresAt" />
                </SortableHeader>
              </Table.Th>
              <Table.Th style={{ width: "10%" }}></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading
              ? skeletonRows
              : sortedShares.map((share) => (
                  <Table.Tr key={share.id}>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        checked={selected.has(share.id)}
                        onChange={() => toggleSelect(share.id)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={share.id} disabled={share.id.length <= 12}>
                        <Text size="sm" truncate>{truncateId(share.id)}</Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>{share.name}</Table.Td>
                    <Table.Td>
                      {share.creator ? (
                        share.creator.username
                      ) : (
                        <Text c="dimmed">Anonymous</Text>
                      )}
                    </Table.Td>
                    <Table.Td>{share.views}</Table.Td>
                    <Table.Td>{byteToHumanSizeString(share.size)}</Table.Td>
                    <Table.Td>
                      {dayjs(share.expiration).unix() === 0
                        ? "Never"
                        : dayjs(share.expiration).format("LLL")}
                    </Table.Td>
                    <Table.Td>
                      <Group justify="right">
                        <ActionIcon
                          variant="light"
                          color="teal"
                          size={25}
                          onClick={() => copyLink(share.id)}
                        >
                          <TbLink />
                        </ActionIcon>
                        <ActionIcon
                          variant="light"
                          color="red"
                          size={25}
                          onClick={() => deleteShare(share)}
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
  );
};

const skeletonRows = [...Array(10)].map((v, i) => (
  <Table.Tr key={i}>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Box component="td" visibleFrom="md">
      <Skeleton key={i} height={20} />
    </Box>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
  </Table.Tr>
));

export default ManageShareTable;
