import {
  Alert,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { TbBuilding, TbLock } from "react-icons/tb";
import useTranslate from "../../../hooks/useTranslate.hook";
import { TEAM_PROFILE_LIMITS } from "../../../utils/fileMetadata.util";
import {
  useSaveTeamProfile,
  useTeamProfile,
} from "../../../utils/teamProfile.util";
import toast from "../../../utils/toast.util";

/**
 * Company details shown in the watermark of contractor previews. Encrypted in
 * the browser with the team key: the server never reads them.
 */
export default function TeamProfilePanel({ teamId }: { teamId: string }) {
  const t = useTranslate();
  const { data, isLoading } = useTeamProfile(teamId, true);
  const save = useSaveTeamProfile(teamId);
  const [companyName, setCompanyName] = useState("");
  const [mention, setMention] = useState("");
  const [details, setDetails] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCompanyName(data?.profile?.companyName ?? "");
    setMention(data?.profile?.mention ?? "");
    setDetails(data?.profile?.details ?? "");
  }, [data]);

  const run = async (profile: Parameters<typeof save>[0]) => {
    setSaving(true);
    try {
      await save(profile);
      toast.success(t(profile ? "team.profile.saved" : "team.profile.removed"));
    } catch {
      toast.error(t("team.profile.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper withBorder p="lg" mb="lg">
      <Group mb="md">
        <TbBuilding size={20} />
        <Title order={4}>{t("team.profile.title")}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {t("team.profile.hint")}
      </Text>
      {!isLoading && data && !data.keyAvailable ? (
        <Alert color="orange" icon={<TbLock size={18} />}>
          {t("team.profile.keyUnavailable")}
        </Alert>
      ) : (
        <Stack gap="sm">
          <TextInput
            label={t("team.profile.companyName")}
            value={companyName}
            maxLength={TEAM_PROFILE_LIMITS.companyName}
            onChange={(event) => setCompanyName(event.currentTarget.value)}
            disabled={isLoading}
          />
          <TextInput
            label={t("team.profile.mention")}
            placeholder={t("team.external.watermark.defaultMention")}
            value={mention}
            maxLength={TEAM_PROFILE_LIMITS.mention}
            onChange={(event) => setMention(event.currentTarget.value)}
            disabled={isLoading}
          />
          <TextInput
            label={t("team.profile.details")}
            description={t("team.profile.detailsHint")}
            value={details}
            maxLength={TEAM_PROFILE_LIMITS.details}
            onChange={(event) => setDetails(event.currentTarget.value)}
            disabled={isLoading}
          />
          <Group justify="flex-end">
            {data?.profile && (
              <Button
                variant="subtle"
                color="red"
                loading={saving}
                onClick={() => run(null)}
              >
                {t("team.profile.remove")}
              </Button>
            )}
            <Button
              loading={saving}
              disabled={isLoading || !companyName.trim()}
              onClick={() =>
                run({
                  companyName,
                  mention: mention || undefined,
                  details: details || undefined,
                })
              }
            >
              {t("common.button.save")}
            </Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
}
