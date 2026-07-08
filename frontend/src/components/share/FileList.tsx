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
import { useCallback, useMemo, useRef, useState } from "react";
import {
  TbChevronDown,
  TbChevronRight,
  TbDownload,
  TbEye,
  TbFile,
  TbFolder,
  TbLink,
} from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import { FileMetaData } from "../../types/File.type";
import DownloadProgressIndicator from "./DownloadProgressIndicator";
import { Share } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { copyToClipboard } from "../../utils/clipboard.util";
import toast from "../../utils/toast.util";
import TableSortIcon, { TableSort } from "../core/SortIcon";
import showFilePreviewModal from "./modals/showFilePreviewModal";
import useConfig from "../../hooks/config.hook";
import { getFileDisplayPath } from "../../utils/uploadPath.util";
import {
  buildFileTree,
  flattenFileTree,
  hasNestedFilePaths,
  type FileTreeFolderNode,
} from "../../utils/fileTree.util";

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
  const [selectedProgress, setSelectedProgress] = useState<number | null>(null);
  const selectedAbortRef = useRef<AbortController | null>(null);

  // -- Per-file download tracking (progress + cancellation) --
  const [downloads, setDownloads] = useState<Map<string, { progress: number; controller: AbortController }>>(new Map());
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );

  // -- Long press for mobile --
  const [longPressTimer, setLongPressTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

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

    const controller = new AbortController();
    selectedAbortRef.current = controller;
    setDownloadingSelected(true);
    setSelectedProgress(0);
    try {
      if (share.isE2EEncrypted && e2eKey) {
        await shareService.downloadSelectedAsZipE2E(
          share.id,
          selectedFiles,
          e2eKey,
          (done, total) => {
            setSelectedProgress(total > 0 ? (done / total) * 100 : 0);
          },
          controller.signal,
        );
      } else {
        await shareService.downloadSelectedAsZip(
          share.id,
          selectedFiles,
          (done, total) => {
            setSelectedProgress(total > 0 ? (done / total) * 100 : 0);
          },
          controller.signal,
        );
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        toast.error(t("common.error"));
      }
    } finally {
      selectedAbortRef.current = null;
      setDownloadingSelected(false);
      setSelectedProgress(null);
    }
  };

  const cancelSelectedDownload = () => {
    selectedAbortRef.current?.abort();
  };

  const startDownload = async (file: FileMetaData) => {
    if (!share) return;
    const controller = new AbortController();

    setDownloads((prev) => {
      const next = new Map(prev);
      next.set(file.id, { progress: 0, controller });
      return next;
    });

    const updateProgress = (downloaded: number, total: number) => {
      const pct = total > 0 ? (downloaded / total) * 100 : 0;
      setDownloads((prev) => {
        const next = new Map(prev);
        const entry = next.get(file.id);
        if (entry) next.set(file.id, { ...entry, progress: Math.min(pct, 100) });
        return next;
      });
    };

    try {
      if (share.isE2EEncrypted && e2eKey) {
        await shareService.downloadFileE2E(
          share.id, file.id, file.name, e2eKey,
          updateProgress,
          controller.signal,
        );
      } else {
        await shareService.downloadFileWithProgress(
          share.id, file.id, file.name,
          updateProgress,
          controller.signal,
        );
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        toast.error(t("common.error"));
      }
    } finally {
      setDownloads((prev) => {
        const next = new Map(prev);
        next.delete(file.id);
        return next;
      });
    }
  };

  const cancelDownload = (fileId: string) => {
    const entry = downloads.get(fileId);
    if (entry) {
      entry.controller.abort();
    }
  };

  const sortedFiles = useMemo(() => {
    if (files && sort.property) {
      return [...files].sort((a, b) => {
        const property = sort.property as keyof FileMetaData;
        if (property === "name") {
          const aName = getFileDisplayPath(a);
          const bName = getFileDisplayPath(b);
          return sort.direction === "asc"
            ? aName.localeCompare(bName, undefined, { numeric: true })
            : bName.localeCompare(aName, undefined, { numeric: true });
        }
        const aValue = String(a[property] ?? "");
        const bValue = String(b[property] ?? "");
        if (sort.direction === "asc") {
          return aValue.localeCompare(bValue, undefined, {
            numeric: true,
          });
        }
        return bValue.localeCompare(aValue, undefined, {
          numeric: true,
        });
      });
    }
    return files;
  }, [files, sort]);

  const shouldUseTree = useMemo(() => hasNestedFilePaths(files), [files]);
  const fileTree = useMemo(
    () => (shouldUseTree ? buildFileTree(sortedFiles) : []),
    [shouldUseTree, sortedFiles],
  );
  const visibleTreeNodes = useMemo(
    () => flattenFileTree(fileTree, collapsedFolders),
    [fileTree, collapsedFolders],
  );

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

  const renderMobileFolderCard = (
    folder: FileTreeFolderNode<FileMetaData>,
  ) => {
    const collapsed = collapsedFolders.has(folder.path);

    return (
      <Card
        key={folder.key}
        withBorder
        p="xs"
        radius="md"
        style={{ marginLeft: folder.depth * 18 }}
      >
        <Group
          gap="xs"
          wrap="nowrap"
          onClick={() => toggleFolder(folder.path)}
          style={{ cursor: "pointer" }}
        >
          <ActionIcon variant="subtle" size={24}>
            {collapsed ? (
              <TbChevronRight size={16} />
            ) : (
              <TbChevronDown size={16} />
            )}
          </ActionIcon>
          <TbFolder size={18} style={{ flexShrink: 0 }} />
          <Text size="sm" fw={600} truncate="end" style={{ minWidth: 0 }}>
            {folder.name}
          </Text>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {t("fileTree.items", { count: folder.fileCount })}
          </Text>
        </Group>
      </Card>
    );
  };

  const renderMobileFileCard = (file: FileMetaData, depth = 0) => {
    const selected = selectedIds.has(file.id);

    return (
      <Card
        key={file.id}
        withBorder
        p="sm"
        radius="md"
        onClick={files.length > 1 ? () => toggleSelection(file.id) : undefined}
        style={{
          cursor: files.length > 1 ? "pointer" : undefined,
          marginLeft: depth * 18,
          touchAction: "pan-y",
        }}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
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
                      backgroundColor:
                        theme.colors[theme.primaryColor][
                          typeof theme.primaryShade === "object"
                            ? theme.primaryShade[
                                theme.other.colorScheme as "light" | "dark"
                              ]
                            : theme.primaryShade
                        ],
                      borderColor:
                        theme.colors[theme.primaryColor][
                          typeof theme.primaryShade === "object"
                            ? theme.primaryShade[
                                theme.other.colorScheme as "light" | "dark"
                              ]
                            : theme.primaryShade
                        ],
                    },
                  },
                })}
              />
            )}
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Text
                size="sm"
                fw={500}
                lineClamp={1}
                style={{ overflowWrap: "anywhere", hyphens: "auto" }}
              >
                {shouldUseTree ? file.name : getFileDisplayPath(file)}
              </Text>
              <Text size="xs" c="dimmed">
                {file.size ? byteToHumanSizeString(parseInt(file.size)) : "-"}
              </Text>
            </Box>
          </Group>
          <Group
            gap={6}
            wrap="nowrap"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {share!.previewEnabled !== false &&
              !(share!.isE2EEncrypted && !e2eKey) &&
              shareService.doesFileSupportPreview(file.name, {
                fileSizeBytes: file.size ? parseInt(file.size) : undefined,
                isE2EEncrypted: share!.isE2EEncrypted,
              }) && (
                <ActionIcon
                  variant="light"
                  size={28}
                  onClick={() =>
                    showFilePreviewModal(share!.id, file, modals, e2eKey)
                  }
                >
                  <TbEye size={16} />
                </ActionIcon>
              )}
            {!share!.hasPassword && !share!.isE2EEncrypted && (
              <ActionIcon
                variant="light"
                size={28}
                onClick={() => copyFileLink(file)}
              >
                <TbLink size={16} />
              </ActionIcon>
            )}
            {downloads.has(file.id) ? (
              <DownloadProgressIndicator
                progress={downloads.get(file.id)!.progress}
                onCancel={() => cancelDownload(file.id)}
              />
            ) : (
              <ActionIcon
                variant="light"
                size={28}
                onClick={() => startDownload(file)}
              >
                <TbDownload size={16} />
              </ActionIcon>
            )}
          </Group>
        </Group>
      </Card>
    );
  };

  const renderDesktopFolderRow = (
    folder: FileTreeFolderNode<FileMetaData>,
  ) => {
    const collapsed = collapsedFolders.has(folder.path);

    return (
      <tr key={folder.key}>
        {files.length > 1 && <td style={{ width: 40 }} />}
        <td>
          <Group
            gap="xs"
            wrap="nowrap"
            onClick={() => toggleFolder(folder.path)}
            style={{
              cursor: "pointer",
              paddingLeft: folder.depth * 22,
              minWidth: 0,
            }}
          >
            <ActionIcon variant="subtle" size={24}>
              {collapsed ? (
                <TbChevronRight size={16} />
              ) : (
                <TbChevronDown size={16} />
              )}
            </ActionIcon>
            <TbFolder size={18} style={{ flexShrink: 0 }} />
            <Text size="sm" fw={600} truncate="end" style={{ minWidth: 0 }}>
              {folder.name}
            </Text>
          </Group>
        </td>
        <td>
          <Text size="xs" c="dimmed">
            {t("fileTree.items", { count: folder.fileCount })}
          </Text>
        </td>
        <td />
      </tr>
    );
  };

  const renderDesktopFileRow = (file: FileMetaData, depth = 0) => (
    <tr
      key={file.id}
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
        <Group
          gap="xs"
          wrap="nowrap"
          style={{
            paddingLeft:
              shouldUseTree ? depth * 22 + 32 : 0,
            minWidth: 0,
          }}
        >
          {shouldUseTree && <TbFile size={16} style={{ flexShrink: 0 }} />}
          <Text
            size="sm"
            style={{
              overflowWrap: "anywhere",
              hyphens: "auto",
              minWidth: 0,
            }}
          >
            {shouldUseTree ? file.name : getFileDisplayPath(file)}
          </Text>
        </Group>
      </td>
      <td>{file.size ? byteToHumanSizeString(parseInt(file.size)) : "-"}</td>
      <td>
        <Group justify="right">
          {share!.previewEnabled !== false &&
            !(share!.isE2EEncrypted && !e2eKey) &&
            shareService.doesFileSupportPreview(file.name, {
              fileSizeBytes: file.size ? parseInt(file.size) : undefined,
              isE2EEncrypted: share!.isE2EEncrypted,
            }) && (
              <ActionIcon
                variant="light"
                color="teal"
                onClick={() =>
                  showFilePreviewModal(share!.id, file, modals, e2eKey)
                }
                size={25}
              >
                <TbEye />
              </ActionIcon>
            )}
          {!share!.hasPassword && !share!.isE2EEncrypted && (
            <ActionIcon
              variant="light"
              color="teal"
              size={25}
              onClick={() => copyFileLink(file)}
            >
              <TbLink />
            </ActionIcon>
          )}
          {downloads.has(file.id) ? (
            <DownloadProgressIndicator
              progress={downloads.get(file.id)!.progress}
              onCancel={() => cancelDownload(file.id)}
            />
          ) : (
            <ActionIcon
              variant="light"
              color="blue"
              size={25}
              onClick={() => startDownload(file)}
            >
              <TbDownload />
            </ActionIcon>
          )}
        </Group>
      </td>
    </tr>
  );

  return (
    <Box>
      {selectionActive && (
        <Group mb="xs" gap="sm">
          <Button
            variant="light"
            size="xs"
            leftSection={<TbDownload size={14} />}
            loading={downloadingSelected}
            disabled={downloadingSelected}
            onClick={handleDownloadSelected}
          >
            <FormattedMessage
              id="share.button.download-selected"
              values={{ count: selectedIds.size }}
            />
          </Button>
          {downloadingSelected && selectedProgress !== null && (
            <DownloadProgressIndicator
              progress={selectedProgress}
              onCancel={cancelSelectedDownload}
            />
          )}
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
        /* --- Mobile: card layout --- */
        <Stack gap="xs" style={{ touchAction: "pan-y" }}>
          {isLoading || !share
            ? [...Array(3)].map((_, i) => (
                <Card key={i} withBorder padding="sm" radius="md">
                  <Skeleton height={14} mb={6} />
                  <Skeleton height={10} width="40%" />
                </Card>
              ))
            : shouldUseTree
              ? visibleTreeNodes.map((node) =>
                  node.type === "folder"
                    ? renderMobileFolderCard(node)
                    : renderMobileFileCard(node.file, node.depth),
                )
              : sortedFiles.map((file) => renderMobileFileCard(file))}
        </Stack>
      ) : (
        /* --- Desktop: table layout --- */
        <Box style={{ display: "block", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
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
                  <Group gap="xs">
                    <FormattedMessage id="share.table.name" />
                    <TableSortIcon sort={sort} setSort={setSort} property="name" />
                  </Group>
                </th>
                <th style={{ textAlign: "left" }}>
                  <Group gap="xs">
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
                : shouldUseTree
                  ? visibleTreeNodes.map((node) =>
                      node.type === "folder"
                        ? renderDesktopFolderRow(node)
                        : renderDesktopFileRow(node.file, node.depth),
                    )
                  : sortedFiles.map((file) => renderDesktopFileRow(file))}
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
