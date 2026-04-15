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
  const t = useTranslate();

  if (isLoading || !share) {
    return (
      <SimpleGrid
        cols={3}
        spacing="md"
        breakpoints={[
          { maxWidth: "md", cols: 2 },
          { maxWidth: "sm", cols: 1 },
        ]}
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
      cols={3}
      spacing="md"
      breakpoints={[
        { maxWidth: "md", cols: 2 },
        { maxWidth: "sm", cols: 1 },
      ]}
    >
      {files.map((file) => {
        const mimeType = (mime.contentType(file.name) || "").split(";")[0];
        const isImage = mimeType.startsWith("image/");
        const supportsPreview =
          share.previewEnabled !== false &&
          shareService.doesFileSupportPreview(file.name);

        return (
          <Card key={file.id} withBorder shadow="sm" radius="md" p="sm">
            <Card.Section
              sx={{
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
                  withPlaceholder
                  placeholder={<TbFile size={48} opacity={0.3} />}
                />
              ) : (
                <Stack align="center" spacing={4}>
                  <TbFile size={48} opacity={0.3} />
                  <Badge size="xs" variant="outline" color="gray">
                    {file.name.split(".").pop()?.toUpperCase() || "FILE"}
                  </Badge>
                </Stack>
              )}
            </Card.Section>

            <Stack spacing={4} mt="sm">
              <Tooltip label={file.name} openDelay={400}>
                <Text size="sm" weight={500} lineClamp={1}>
                  {file.name}
                </Text>
              </Tooltip>
              <Text size="xs" color="dimmed">
                {file.size
                  ? byteToHumanSizeString(parseInt(file.size))
                  : "--"}
              </Text>
            </Stack>

            <Group position="right" mt="xs" spacing={4}>
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
