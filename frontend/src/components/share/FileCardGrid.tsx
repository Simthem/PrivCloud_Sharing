import {
  ActionIcon,
  Badge,
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
import { TbDownload, TbEye, TbFile } from "react-icons/tb";
import mime from "mime-types";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import { FileMetaData } from "../../types/File.type";
import { Share } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
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
  const _t = useTranslate();

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

  return (
    <SimpleGrid
      cols={{ base: 1, sm: 2, md: 3 }}
      spacing="md"
    >
      {files.map((file) => {
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
              <Tooltip label={file.name} openDelay={400}>
                <Text
                  size="sm"
                  fw={500}
                  lineClamp={1}
                  style={{ overflowWrap: "anywhere", hyphens: "auto" }}
                >
                  {file.name}
                </Text>
              </Tooltip>
              <Text size="xs" c="dimmed">
                {file.size
                  ? byteToHumanSizeString(parseInt(file.size))
                  : "--"}
              </Text>
            </Stack>

            <Group justify="right" mt="xs" gap={4}>
              {supportsPreview && (
                <ActionIcon
                  size={28}
                  variant="light"
                  onClick={() =>
                    showFilePreviewModal(share.id, file, modals, e2eKey)
                  }
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
      })}
    </SimpleGrid>
  );
};

export default FileCardGrid;
