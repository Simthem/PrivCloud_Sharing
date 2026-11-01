import { Alert, Button, Collapse, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure, useId } from "@mantine/hooks";
import { TbChevronRight, TbKey, TbLockOpen } from "react-icons/tb";
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
  const [detailsOpened, details] = useDisclosure(false);
  const detailsId = useId();
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
        <div className={styles.encryptionDetails}>
          <UnstyledButton
            className={styles.encryptionDetailsToggle}
            aria-expanded={detailsOpened}
            aria-controls={detailsId}
            onClick={details.toggle}
          >
            <TbChevronRight
              size={12}
              data-disclosure-chevron
              data-opened={detailsOpened || undefined}
              aria-hidden
            />
            {t("team.dashboard.e2e.details")}
          </UnstyledButton>
          <Collapse in={detailsOpened} id={detailsId}>
            <Text size="xs" pt={6}>
              {t("team.dashboard.e2e.banner.activeDesc")}
            </Text>
          </Collapse>
        </div>
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
