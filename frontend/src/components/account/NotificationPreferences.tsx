import classes from "./NotificationSettings.module.css";
import { TbDownload } from "react-icons/tb";
import { Box, Group, Radio, Stack, Text, Title } from "@mantine/core";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import userService from "../../services/user.service";
import toast from "../../utils/toast.util";
import SignaturePushPreference from "./SignaturePushPreference";

export default function NotificationPreferences() {
  const { user, refreshUser } = useUser();
  const t = useTranslate();
  return (
    <Stack gap="xl">
      <SignaturePushPreference />
      <Box
        className={classes.preference}
        data-testid="download-notification-preference"
      >
        <Group gap="xs" mb="xs" wrap="nowrap">
          <TbDownload size={18} aria-hidden="true" />
          <Title order={5}>{t("account.notify.title")}</Title>
        </Group>
        <Text size="sm" c="dimmed" mb="sm">
          {t("account.notify.description")}
        </Text>
        <Radio.Group
          value={user?.notificationMode ?? "DIGEST"}
          onChange={async (value) => {
            try {
              await userService.updateCurrentUser({
                notificationMode: value,
              });
              await refreshUser();
              toast.success(t("common.success"));
            } catch {
              toast.error(t("common.error"));
            }
          }}
        >
          <Stack gap="xs">
            <Radio
              value="INSTANT"
              label={t("account.notify.instant.label")}
              description={t("account.notify.instant.description")}
            />
            <Radio
              value="DIGEST"
              label={t("account.notify.digest.label")}
              description={t("account.notify.digest.description")}
            />
            <Radio
              value="WEEKLY"
              label={t("account.notify.weekly.label")}
              description={t("account.notify.weekly.description")}
            />
          </Stack>
        </Radio.Group>
      </Box>
    </Stack>
  );
}
