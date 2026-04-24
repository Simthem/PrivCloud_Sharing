import {
  ActionIcon,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { useCallback, useMemo, useState } from "react";
import { TbDownload, TbEye, TbLink } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import { FileMetaData } from "../../types/File.type";
import { Share } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { copyToClipboard } from "../../utils/clipboard.util";
import toast from "../../utils/toast.util";
import TableSortIcon, { TableSort } from "../core/SortIcon";
import showFilePreviewModal from "./modals/showFilePreviewModal";
import useConfig from "../../hooks/config.hook";

const FileList = ({
  files,
  share,
  isLoading,
  e2eKey,
}: {
  files: FileMetaData[];
  share?: Share;
  isLoading: boolean;
  e2eKey?: string | null;
}) => {
  const modals = useModals();
  const t = useTranslate();
  const config = useConfig();
  const isMobile = useMediaQuery("(max-width: 680px)");

  const [sort, setSort] = useState<TableSort>({
    property: "name",
    direction: "desc",
  });

  // -- Selection state --
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloadingSelected, setDownloadingSelected] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState("");

  // -- Long press for mobile --
  const [longPressTimer, setLongPressTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const toggleSelection = useCallback((fileId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (!files) return;
    setSelectedIds((prev) => {
      if (prev.size === files.length) return new Set();
      return new Set(files.map((f) => f.id));
    });
  }, [files]);

  const handleLongPressStart = useCallback((fileId: string) => {
    const timer = setTimeout(() => {
      toggleSelection(fileId);
    }, 500);
    setLongPressTimer(timer);
  }, [toggleSelection]);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      setLongPressTimer(null);
    }
  }, [longPressTimer]);

  const handleDownloadSelected = async () => {
    if (!share || selectedIds.size === 0) return;

    const selectedFiles = files.filter((f) => selectedIds.has(f.id));

    if (selectedFiles.length === 1) {
      const file = selectedFiles[0];
      if (share.isE2EEncrypted && e2eKey) {
        await shareService.downloadFileE2E(share.id, file.id, file.name, e2eKey);
      } else {
        await shareService.downloadFile(share.id, file.id);
      }
      return;
    }

    setDownloadingSelected(true);
    setDownloadProgress("");
    try {
      if (share.isE2EEncrypted && e2eKey) {
        await shareService.downloadSelectedAsZipE2E(
          share.id,
          selectedFiles,
          e2eKey,
          (done, total) => setDownloadProgress(`${done}/${total}`),
        );
      } else {
        await shareService.downloadSelectedAsZip(
          share.id,
          selectedFiles,
          (done, total) => setDownloadProgress(`${done}/${total}`),
        );
      }
    } catch {
      toast.error(t("common.error"));
    } finally {
      setDownloadingSelected(false);
      setDownloadProgress("");
    }
  };

  const sortedFiles = useMemo(() => {
    if (files && sort.property) {
      return [...files].sort((a, b) => {
        const property = sort.property as keyof FileMetaData;
        if (sort.direction === "asc") {
          return a[property].localeCompare(b[property], undefined, {
            numeric: true,
          });
        }
        return b[property].localeCompare(a[property], undefined, {
          numeric: true,
        });
      });
    }
    return files;
  }, [files, sort]);

  const copyFileLink = async (file: FileMetaData) => {
    const link = `${config.get("general.appUrl")}/api/shares/${
      share!.id
    }/files/${file.id}`;

    const ok = await copyToClipboard(link);
    if (ok) {
      toast.success(t("common.notify.copied-link"));
    } else {
      modals.openModal({
        title: t("share.modal.file-link"),
        children: (
          <Stack align="stretch">
            <TextInput variant="filled" value={link} />
          </Stack>
        ),
      });
    }
  };

  const selectionActive = selectedIds.size > 0;
  const allSelected = files.length > 0 && selectedIds.size === files.length;

  return (
    <Box>
      {selectionActive && (
        <Group mb="xs" spacing="sm">
          <Button
            variant="light"
            size="xs"
            leftIcon={<TbDownload size={14} />}
            loading={downloadingSelected}
            onClick={handleDownloadSelected}
          >
            {downloadProgress ? (
              <Text size="xs">{downloadProgress}</Text>
            ) : (
              <FormattedMessage
                id="share.button.download-selected"
                values={{ count: selectedIds.size }}
              />
            )}
          </Button>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => setSelectedIds(new Set())}
          >
            <FormattedMessage id="share.button.clear-selection" />
          </Button>
        </Group>
      )}
      {isMobile ? (
        /* Mobile: card layout */
        <Stack spacing="xs">
          {isLoading || !share
            ? [...Array(3)].map((_, i) => (
                <Card key={i} withBorder padding="sm" radius="md">
                  <Skeleton height={14} mb={6} />
                  <Skeleton height={10} width="40%" />
                </Card>
              ))
            : sortedFiles.map((file) => {
                const selected = selectedIds.has(file.id);
                return (
                  <Card
                    key={file.id}
                    withBorder
                    padding="sm"
                    radius="md"
                    onClick={() => {
                      if (files.length > 1) toggleSelection(file.id);
                    }}
                    sx={(theme) => {
                      const pc = theme.primaryColor;
                      const shade = theme.fn.primaryShade();
                      return {
                        cursor: files.length > 1 ? "pointer" : undefined,
                        borderColor: selected
                          ? theme.colors[pc][shade]
                          : undefined,
                        backgroundColor: selected
                          ? theme.colorScheme === "dark"
                            ? theme.fn.rgba(theme.colors[pc][8], 0.15)
                            : theme.fn.rgba(theme.colors[pc][1], 0.5)
                          : undefined,
                      };
                    }}
                  >
                    <Group position="apart" noWrap>
                      <Group spacing="sm" noWrap style={{ minWidth: 0, flex: 1 }}>
                        {files.length > 1 && (
                          <Checkbox
                            size="xs"
                            checked={selected}
                            onChange={() => toggleSelection(file.id)}
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            styles={(theme) => ({
                              input: {
                                cursor: "pointer",
                                "&:checked": {
                                  backgroundColor: theme.colors[theme.primaryColor][theme.fn.primaryShade()],
                                  borderColor: theme.colors[theme.primaryColor][theme.fn.primaryShade()],
                                },
                              },
                            })}
                          />
                        )}
                        <Box style={{ minWidth: 0 }}>
                          <Text size="sm" weight={500} lineClamp={1}>
                            {file.name}
                          </Text>
                          <Text size="xs" color="dimmed">
                            {file.size
                              ? byteToHumanSizeString(parseInt(file.size))
                              : "-"}
                          </Text>
                        </Box>
                      </Group>
                      <Group spacing={6} noWrap onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                        {share.previewEnabled !== false &&
                          shareService.doesFileSupportPreview(file.name) && (
                          <ActionIcon
                            variant="light"
                            size={28}
                            onClick={() =>
                              showFilePreviewModal(share.id, file, modals, e2eKey)
                            }
                          >
                            <TbEye size={16} />
                          </ActionIcon>
                        )}
                        {!share.hasPassword && !share.isE2EEncrypted && (
                          <ActionIcon
                            variant="light"
                            size={28}
                            onClick={() => copyFileLink(file)}
                          >
                            <TbLink size={16} />
                          </ActionIcon>
                        )}
                        <ActionIcon
                          variant="light"
                          size={28}
                          onClick={async () => {
                            if (share.isE2EEncrypted && e2eKey) {
                              await shareService.downloadFileE2E(
                                share.id,
                                file.id,
                                file.name,
                                e2eKey,
                              );
                            } else {
                              await shareService.downloadFile(share.id, file.id);
                            }
                          }}
                        >
                          <TbDownload size={16} />
                        </ActionIcon>
                      </Group>
                    </Group>
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
                {files.length > 1 && (
                  <th style={{ width: 40, textAlign: "left" }}>
                    <Checkbox
                      size="xs"
                      checked={allSelected}
                      indeterminate={selectionActive && !allSelected}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th style={{ textAlign: "left" }}>
                  <Group spacing="xs">
                    <FormattedMessage id="share.table.name" />
                    <TableSortIcon sort={sort} setSort={setSort} property="name" />
                  </Group>
                </th>
                <th style={{ textAlign: "left" }}>
                  <Group spacing="xs">
                    <FormattedMessage id="share.table.size" />
                    <TableSortIcon sort={sort} setSort={setSort} property="size" />
                  </Group>
                </th>
                <th style={{ textAlign: "left" }}></th>
              </tr>
            </thead>
            <tbody>
              {isLoading || !share
                ? skeletonRows
                : sortedFiles.map((file, index) => (
                    <tr
                      key={index}
                      onTouchStart={() => handleLongPressStart(file.id)}
                      onTouchEnd={handleLongPressEnd}
                      onTouchCancel={handleLongPressEnd}
                    >
                      {files.length > 1 && (
                        <td style={{ width: 40 }}>
                          <Checkbox
                            size="xs"
                            checked={selectedIds.has(file.id)}
                            onChange={() => toggleSelection(file.id)}
                          />
                        </td>
                      )}
                      <td
                        style={{ cursor: files.length > 1 ? "pointer" : undefined }}
                        onClick={files.length > 1 ? () => toggleSelection(file.id) : undefined}
                      >
                        {file.name}
                      </td>
                      <td>
                        {file.size
                          ? byteToHumanSizeString(parseInt(file.size))
                          : "-"}
                      </td>
                      <td>
                        <Group position="right">
                          {share.previewEnabled !== false &&
                            shareService.doesFileSupportPreview(file.name) && (
                            <ActionIcon
                              variant="light"
                              color="teal"
                              onClick={() =>
                                showFilePreviewModal(share.id, file, modals, e2eKey)
                              }
                              size={25}
                            >
                              <TbEye />
                            </ActionIcon>
                          )}
                          {!share.hasPassword && !share.isE2EEncrypted && (
                            <ActionIcon
                              variant="light"
                              color="teal"
                              size={25}
                              onClick={() => copyFileLink(file)}
                            >
                              <TbLink />
                            </ActionIcon>
                          )}
                          <ActionIcon
                            variant="light"
                            color="blue"
                            size={25}
                            onClick={async () => {
                              if (share.isE2EEncrypted && e2eKey) {
                                await shareService.downloadFileE2E(
                                  share.id,
                                  file.id,
                                  file.name,
                                  e2eKey,
                                );
                              } else {
                                await shareService.downloadFile(share.id, file.id);
                              }
                            }}
                          >
                            <TbDownload />
                          </ActionIcon>
                        </Group>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </Table>
        </Box>
      )}
    </Box>
  );
};

const skeletonRows = [...Array(5)].map((c, i) => (
  <tr key={i}>
    <td>
      <Skeleton height={30} width={30} />
    </td>
    <td>
      <Skeleton height={14} />
    </td>
    <td>
      <Skeleton height={25} width={25} />
    </td>
  </tr>
));

export default FileList;
