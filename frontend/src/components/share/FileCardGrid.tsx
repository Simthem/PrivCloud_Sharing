import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Group,
  Image,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useMemo, useState } from "react";
import {
  TbChevronDown,
  TbChevronRight,
  TbDownload,
  TbEye,
  TbFile,
  TbFolder,
} from "react-icons/tb";
import mime from "mime-types";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import { FileMetaData } from "../../types/File.type";
import { Share } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { getFileDisplayPath } from "../../utils/uploadPath.util";
import {
  buildFileTree,
  hasNestedFilePaths,
  type FileTreeNode,
} from "../../utils/fileTree.util";
import showFilePreviewModal from "./modals/showFilePreviewModal";

const FileCardGrid = ({
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
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const shouldUseTree = useMemo(() => hasNestedFilePaths(files), [files]);
  const fileTree = useMemo(
    () => (shouldUseTree ? buildFileTree(files) : []),
    [files, shouldUseTree],
  );

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  if (isLoading || !share) {
    return (
      <SimpleGrid
        cols={{ base: 1, sm: 2, md: 3 }}
        spacing="md"
      >
        {[...Array(6)].map((_, i) => (
          <Card key={i} withBorder shadow="sm" radius="md" p="md">
            <Skeleton height={120} mb="sm" />
            <Skeleton height={16} width="60%" />
          </Card>
        ))}
      </SimpleGrid>
    );
  }

  const renderFileCard = (file: FileMetaData) => {
    const displayPath = getFileDisplayPath(file);
    const mimeType = (mime.contentType(file.name) || "").split(";")[0];
    const isImage = mimeType.startsWith("image/");
    const supportsPreview =
      share.previewEnabled !== false &&
      !(share.isE2EEncrypted && !e2eKey) &&
      shareService.doesFileSupportPreview(file.name, {
        fileSizeBytes: file.size ? parseInt(file.size) : undefined,
        isE2EEncrypted: share.isE2EEncrypted,
      });

    return (
      <Card key={file.id} withBorder shadow="sm" radius="md" p="sm">
        <Card.Section
          style={{
            height: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.03)",
            overflow: "hidden",
          }}
        >
          {isImage ? (
            <Image
              src={`/api/shares/${share.id}/files/${file.id}`}
              alt={file.name}
              height={140}
              fit="contain"
              fallbackSrc=""
            />
          ) : (
            <Stack align="center" gap={4}>
              <TbFile size={48} opacity={0.3} />
              <Badge size="xs" variant="outline" color="gray">
                {file.name.split(".").pop()?.toUpperCase() || "FILE"}
              </Badge>
            </Stack>
          )}
        </Card.Section>

        <Stack gap={4} mt="sm">
          <Tooltip label={displayPath} openDelay={400}>
            <Text
              size="sm"
              fw={500}
              lineClamp={1}
              style={{ overflowWrap: "anywhere", hyphens: "auto" }}
            >
              {shouldUseTree ? file.name : displayPath}
            </Text>
          </Tooltip>
          <Text size="xs" c="dimmed">
            {file.size ? byteToHumanSizeString(parseInt(file.size)) : "--"}
          </Text>
        </Stack>

        <Group justify="right" mt="xs" gap={4}>
          {supportsPreview && (
            <ActionIcon
              size={28}
              variant="light"
              onClick={() => showFilePreviewModal(share.id, file, modals, e2eKey)}
            >
              <TbEye size={16} />
            </ActionIcon>
          )}
          <ActionIcon
            size={28}
            variant="light"
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
      </Card>
    );
  };

  const renderGridNodes = (
    nodes: FileTreeNode<FileMetaData>[],
    depth = 0,
  ): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    let fileBatch: FileMetaData[] = [];

    const flushFiles = () => {
      if (fileBatch.length === 0) return;

      elements.push(
        <SimpleGrid
          key={`files:${depth}:${elements.length}`}
          cols={{ base: 1, sm: 2, md: 3 }}
          spacing="md"
        >
          {fileBatch.map(renderFileCard)}
        </SimpleGrid>,
      );
      fileBatch = [];
    };

    nodes.forEach((node) => {
      if (node.type === "file") {
        fileBatch.push(node.file);
        return;
      }

      flushFiles();

      const collapsed = collapsedFolders.has(node.path);
      elements.push(
        <Box key={node.key} pl={depth === 0 ? 0 : 18}>
          <Group
            gap="xs"
            mb="xs"
            wrap="nowrap"
            onClick={() => toggleFolder(node.path)}
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
              {node.name}
            </Text>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {t("fileTree.items", { count: node.fileCount })}
            </Text>
          </Group>
          {!collapsed && (
            <Stack gap="sm" pl={26}>
              {renderGridNodes(node.children, depth + 1)}
            </Stack>
          )}
        </Box>,
      );
    });

    flushFiles();
    return elements;
  };

  if (shouldUseTree) {
    return <Stack gap="md">{renderGridNodes(fileTree)}</Stack>;
  }

  return (
    <SimpleGrid
      cols={{ base: 1, sm: 2, md: 3 }}
      spacing="md"
    >
      {files.map((file) => {
        return renderFileCard(file);
      })}
    </SimpleGrid>
  );
};

export default FileCardGrid;
