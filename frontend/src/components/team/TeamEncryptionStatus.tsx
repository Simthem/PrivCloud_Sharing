import { Alert, Button, Text } from "@mantine/core";
import { TbKey, TbLockOpen } from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";
import styles from "./TeamDashboard.module.css";

export default function TeamEncryptionStatus({
  canRotate,
  onRotate,
}: {
  canRotate: boolean;
  onRotate: () => void;
}) {
  const t = useTranslate();
  return (
    <Alert
      icon={<TbLockOpen size={18} />}
      color="green"
      className={styles.activeEncryption}
      title={t("team.dashboard.e2e.banner.activeTitle")}
    >
      <div className={styles.encryptionActions}>
        <Text size="sm" className={styles.encryptionDescription}>
          {t("team.dashboard.e2e.banner.activeDesc")}
        </Text>
        <details className={styles.encryptionDetails}>
          <summary>{t("team.dashboard.e2e.details")}</summary>
          <Text size="xs">{t("team.dashboard.e2e.banner.activeDesc")}</Text>
        </details>
        {canRotate && (
          <Button
            size="compact-sm"
            color="orange"
            variant="light"
            leftSection={<TbKey size={14} />}
            onClick={onRotate}
          >
            <span className={styles.desktopOnly}>
              {t("team.dashboard.e2e.rotateButton")}
            </span>
            <span className={styles.mobileOnly}>
              {t("team.dashboard.e2e.rotateShort")}
            </span>
          </Button>
        )}
      </div>
    </Alert>
  );
}
