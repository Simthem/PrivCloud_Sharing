import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import shareService from "../../services/share.service";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import dayjs from "../../utils/dayjs";

export default function PendingUploads({
  teamFolderId,
}: {
  teamFolderId?: string;
}) {
  const t = useTranslate();
  const { user } = useUser();
  const { data } = useQuery({
    queryKey: ["pendingUploads", user?.id],
    queryFn: shareService.getPendingUploads,
    enabled: !!user,
    refetchInterval: 30_000,
  });
  const uploads = (data ?? []).filter(
    (upload) => !teamFolderId || upload.teamFolderId === teamFolderId,
  );
  if (uploads.length === 0) return null;
  return (
    <Alert title={t("upload.pending.title")} color="orange" mb="lg">
      <Text size="sm" mb="sm">
        {t("upload.pending.body")}
      </Text>
      <Stack gap="sm">
        {uploads.map((upload) => (
          <Group key={upload.id} justify="space-between" wrap="wrap">
            <Text size="sm">
              {t("upload.pending.summary", {
                date: dayjs(upload.createdAt).format("LLL"),
                count: upload.fileCount,
                size: byteToHumanSizeString(upload.size),
              })}
            </Text>
            <Group gap="xs">
              <Button
                component={Link}
                href={`/share/${encodeURIComponent(upload.id)}/edit`}
                disabled={!upload.canResume}
                size="xs"
              >
                {t("upload.pending.resume")}
              </Button>
              <Button
                component={Link}
                href={`/share/${encodeURIComponent(upload.id)}`}
                disabled={upload.fileCount === 0}
                size="xs"
                variant="light"
              >
                {t("upload.pending.open")}
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
    </Alert>
  );
}
