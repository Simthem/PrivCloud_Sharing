import "@mantine/core/styles/Switch.css";
import classes from "./NotificationSettings.module.css";
import { TbWritingSign } from "react-icons/tb";
import { Box, Group, Switch, Text, Title } from "@mantine/core";
import { useState, useEffect, useRef } from "react";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import userService from "../../services/user.service";
import toast from "../../utils/toast.util";

const SignaturePushPreference = () => {
  const { user, refreshUser } = useUser();
  const t = useTranslate();
  const [saving, setSaving] = useState(false);

  const userId = user?.id;
  const preferenceRevision = useRef(0);
  const [verifiedPreference, setVerifiedPreference] = useState<{
    userId: string;
    eligible?: boolean;
    enabled?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    const revision = ++preferenceRevision.current;
    void userService
      .getCurrentUserStrict()
      .then((current) => {
        if (
          active &&
          revision === preferenceRevision.current &&
          current.id === userId
        )
          setVerifiedPreference({
            userId,
            eligible: current.signaturePushEligible,
            enabled: current.signaturePushEnabled,
          });
      })
      .catch(() => {
        /* The last confirmed preference remains available. */
      });
    return () => {
      active = false;
    };
  }, [userId, user?.signaturePushEligible, user?.signaturePushEnabled]);
  const confirmed =
    verifiedPreference?.userId === userId ? verifiedPreference : null;
  const eligible = confirmed?.eligible ?? user?.signaturePushEligible;
  const enabled = confirmed?.enabled ?? user?.signaturePushEnabled;
  if (!user || eligible === false) return null;

  const updatePreference = async (enabled: boolean) => {
    setSaving(true);
    preferenceRevision.current++;
    try {
      const updated = await userService.updateCurrentUser({
        signaturePushEnabled: enabled,
      });
      if (updated?.signaturePushEnabled !== enabled)
        throw new Error("Signature preference was not saved");
      if (userId) setVerifiedPreference({ userId, eligible: true, enabled });
      await refreshUser();
      toast.success(t("common.success"));
    } catch {
      toast.error(t("common.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box className={classes.preference} data-testid="signature-push-preference">
      <Group gap="xs" mb="xs" wrap="nowrap">
        <TbWritingSign size={18} aria-hidden="true" />
        <Title order={5}>{t("account.notify.signature.title")}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t("account.notify.signature.description")}
      </Text>
      {eligible !== true && (
        <Text size="sm" c="dimmed" mb="sm">
          {t("account.notify.signature.unavailable")}
        </Text>
      )}
      <Switch
        checked={enabled === true}
        disabled={saving || eligible !== true}
        label={t("account.notify.signature.label")}
        onChange={(event) => void updatePreference(event.currentTarget.checked)}
      />
    </Box>
  );
};

export default SignaturePushPreference;
