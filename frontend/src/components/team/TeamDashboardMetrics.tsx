import { Card, RingProgress, Text } from "@mantine/core";
import { useIntl } from "react-intl";
import { useMediaQuery } from "@mantine/hooks";
import useTranslate from "../../hooks/useTranslate.hook";
import type { TeamMetrics } from "../../services/team.service";
import styles from "./TeamDashboard.module.css";

export default function TeamDashboardMetrics({
  metrics,
}: {
  metrics: TeamMetrics;
}) {
  const t = useTranslate();
  const intl = useIntl();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const formatBytes = (bytes: number) => {
    const unit =
      bytes >= 1_000_000_000
        ? "GB"
        : bytes >= 1_000_000
          ? "MB"
          : bytes >= 1_000
            ? "KB"
            : "B";
    const divisor =
      unit === "GB"
        ? 1_000_000_000
        : unit === "MB"
          ? 1_000_000
          : unit === "KB"
            ? 1_000
            : 1;
    const digits = unit === "GB" || unit === "MB" ? 1 : 0;
    return (
      intl.formatNumber(bytes / divisor, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }) +
      " " +
      unit
    );
  };
  const percentage = metrics.storage.percentage;
  const color = percentage > 90 ? "red" : percentage > 70 ? "yellow" : "blue";
  return (
    <div className={styles.metrics} data-team-metrics>
      <Card withBorder className={`${styles.metric} ${styles.storage}`}>
        <div className={styles.storageValues} data-storage-values>
          <Text className={styles.label}>
            {t("team.dashboard.metrics.storage")}
          </Text>

          <Text size="xs" c="dimmed" data-storage-amount>
            {t("team.dashboard.metrics.folderStorage", {
              size: formatBytes(
                metrics.storage.folderUsed ?? metrics.storage.used,
              ),
            })}
          </Text>
          <Text size="xs" c="dimmed" data-storage-amount>
            {t("team.dashboard.metrics.quotaStorage", {
              used: formatBytes(metrics.storage.used),
              limit: formatBytes(metrics.storage.limit),
            })}
          </Text>
        </div>
        <div className={styles.storageGauge} data-storage-gauge>
          <RingProgress
            size={isMobile ? 56 : 76}
            thickness={isMobile ? 5 : 6}
            sections={[
              { value: Math.min(Math.max(percentage, 0), 100), color },
            ]}
            label={
              <Text ta="center" size={isMobile ? "xs" : "sm"} fw={700}>
                {intl.formatNumber(percentage)}%
              </Text>
            }
          />
        </div>
      </Card>
      <Card withBorder className={styles.metric}>
        <Text className={styles.label}>
          {t("team.dashboard.metrics.members")}
        </Text>
        <Text className={styles.value}>
          {intl.formatNumber(metrics.team.membersCount)} /{" "}
          {intl.formatNumber(metrics.team.maxMembers)}
        </Text>
        <Text size="xs" c="dimmed">
          <span className={styles.desktopOnly}>
            {t("team.dashboard.metrics.membersRemaining", {
              n: metrics.team.maxMembers - metrics.team.membersCount,
            })}
          </span>
          <span className={styles.mobileOnly}>
            {t("team.dashboard.metrics.availableSeats", {
              count: metrics.team.maxMembers - metrics.team.membersCount,
            })}
          </span>
        </Text>
      </Card>
      <Card withBorder className={styles.metric}>
        <Text className={styles.label}>
          <span className={styles.desktopOnly}>
            {t("team.dashboard.metrics.downloads30d")}
          </span>
          <span
            className={styles.mobileOnly}
            aria-label={t("team.dashboard.metrics.downloads30d")}
          >
            {t("team.dashboard.metrics.downloadsShort")}
          </span>
        </Text>
        <Text className={styles.value}>
          {intl.formatNumber(metrics.activity.downloads)}
        </Text>
        <Text size="xs" c="dimmed">
          {t("team.dashboard.metrics.uploadCount", {
            count: metrics.activity.uploads,
          })}
        </Text>
      </Card>
      <Card withBorder className={styles.metric}>
        <Text className={styles.label}>
          {t("team.dashboard.metrics.files")}
        </Text>
        <Text className={styles.value}>
          {intl.formatNumber(metrics.activity.totalFiles)}
        </Text>
        <Text size="xs" c="dimmed">
          {t("team.dashboard.metrics.foldersCount", {
            n: metrics.team.foldersCount,
          })}
        </Text>
      </Card>
    </div>
  );
}
