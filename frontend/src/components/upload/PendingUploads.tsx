import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef } from "react";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import shareService from "../../services/share.service";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import dayjs from "../../utils/dayjs";

export default function PendingUploads({
  teamFolderId,
  onSettled,
}: {
  teamFolderId?: string;
  /** Called when a listed upload leaves the list: finished elsewhere or deleted. */
  onSettled?: () => void;
}) {
  const t = useTranslate();
  const { user } = useUser();
  const { data } = useQuery({
    queryKey: ["pendingUploads", user?.id],
    queryFn: shareService.getPendingUploads,
    enabled: !!user,
    refetchInterval: 30_000,
  });
  const isListed = (upload: { teamFolderId?: string | null }) =>
    !teamFolderId || upload.teamFolderId === teamFolderId;
  const uploads = (data ?? []).filter(isListed);

  // A native upload keeps running after its page is left and finishes without
  // anyone on the upload page to refresh the caches. Its share then drops out
  // of this polled list, which is the signal the content around it changed.
  const listedIds = useRef<Set<string> | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.filter(isListed).map((upload) => upload.id));
    const previous = listedIds.current;
    listedIds.current = ids;
    if (previous && [...previous].some((id) => !ids.has(id))) {
      onSettledRef.current?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isListed only reads teamFolderId
  }, [data, teamFolderId]);

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
