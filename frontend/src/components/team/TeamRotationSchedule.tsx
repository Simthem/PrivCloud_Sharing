import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useIntl } from "react-intl";
import teamService from "../../services/team.service";
import useTranslate from "../../hooks/useTranslate.hook";
import { rotationDaysRemaining } from "../../utils/teamRotationSchedule.util";

export default function TeamRotationSchedule({ teamId }: { teamId: string }) {
  const t = useTranslate();
  const intl = useIntl();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["team.keyRotation", teamId],
    queryFn: () => teamService.getKeyRotationStatus(teamId),
    refetchInterval: 60_000,
  });
  if (isPending) return <Loader size="sm" mb="md" />;
  const days = data && rotationDaysRemaining(data.policy.nextDueAt);
  if (isError || days == null || !data)
    return (
      <Alert color="orange" mb="md">
        <Stack gap="xs" align="flex-start">
          <Text size="sm">{t("team.settings.rotation.loadError")}</Text>
          <Button variant="light" size="xs" onClick={() => void refetch()}>
            {t("common.button.retry")}
          </Button>
        </Stack>
      </Alert>
    );
  const active = data.activeRotation;
  return (
    <Alert
      color={
        active
          ? "blue"
          : data.policy.isDue
            ? "red"
            : data.policy.reminderActive
              ? "yellow"
              : "teal"
      }
      mb="md"
    >
      <Stack gap="xs">
        <Text fw={600}>
          {active
            ? t(
                active.status === "PAUSED"
                  ? "team.settings.rotation.paused"
                  : "team.settings.rotation.active",
                { done: active.processedFiles, total: active.totalFiles },
              )
            : t(
                data.policy.isDue
                  ? "team.settings.rotation.due"
                  : "team.settings.rotation.remaining",
                { count: days },
              )}
        </Text>
        <Text size="sm">
          {t("team.settings.rotation.nextDue", {
            date: intl.formatDate(data.policy.nextDueAt, {
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
          })}
        </Text>
        <Text size="xs">{t("team.settings.rotation.assisted")}</Text>
        <Group>
          <Button
            component={Link}
            href={`/team/${encodeURIComponent(teamId)}#e2e-rotation`}
            variant="light"
            size="xs"
          >
            {t("team.settings.rotation.manage")}
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
