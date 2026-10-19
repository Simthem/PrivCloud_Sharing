import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core"
import dayjs from "dayjs"
import { useState } from "react"
import useTranslate from "../../../hooks/useTranslate.hook"
import type {
  ExternalAuditEvent,
  ExternalJournal,
} from "../../../services/teamExternal.service"

/** Journal of one copy, with the verification of the whole team chain. */
export default function AuditJournalModal({
  opened,
  onClose,
  journal,
  onDiagnostic,
}: {
  opened: boolean
  onClose: () => void
  // Undefined while loading.
  journal: ExternalJournal | undefined
  onDiagnostic?: () => Promise<void>
}) {
  const t = useTranslate()
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(false)
  const downloadDiagnostic = async () => {
    setDownloading(true)
    setDownloadError(false)
    try {
      await onDiagnostic?.()
    } catch {
      setDownloadError(true)
    } finally {
      setDownloading(false)
    }
  }
  const eventLabel = (event: ExternalAuditEvent) =>
    event.kind === "PAGE"
      ? t("team.audit.journal.page", { page: (event.pageIndex ?? 0) + 1 })
      : t(`team.audit.journal.${event.kind.toLowerCase()}`)

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("team.audit.journal.title")}
      size="lg"
    >
      {!journal ? (
        <Loader size="sm" />
      ) : (
        <Stack gap="sm">
          <Alert color={journal.verification.valid ? "teal" : "red"}>
            {journal.verification.valid
              ? journal.verification.lastAnchorAt
                ? t("team.audit.journal.valid", {
                    count: journal.verification.events,
                    anchor: dayjs(journal.verification.lastAnchorAt).format(
                      "L LT",
                    ),
                  })
                : t("team.audit.journal.validNoAnchor", {
                    count: journal.verification.events,
                  })
              : t("team.audit.journal.broken", {
                  seq: journal.verification.brokenAtSeq ?? "-",
                })}
          </Alert>
          {!journal.verification.valid && journal.verification.reason && (
            <Text size="sm">
              {t(`team.audit.journal.reason.${journal.verification.reason}`)}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t("team.audit.journal.scope")}
          </Text>
          {!journal.verification.valid && onDiagnostic && (
            <Stack gap={4}>
              <Button
                size="xs"
                variant="light"
                loading={downloading}
                onClick={downloadDiagnostic}
              >
                {t("team.audit.journal.diagnostic.download")}
              </Button>
              <Text size="xs" c="dimmed">
                {t("team.audit.journal.diagnostic.private")}
              </Text>
              {downloadError && (
                <Text size="xs" c="red">
                  {t("team.audit.journal.diagnostic.error")}
                </Text>
              )}
            </Stack>
          )}
          {journal.events.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("team.audit.journal.empty")}
            </Text>
          ) : (
            <ScrollArea.Autosize mah={420}>
              <Stack gap={4}>
                {journal.events.map((event) => (
                  <Group key={event.seq} justify="space-between" wrap="nowrap">
                    <Text size="sm">{eventLabel(event)}</Text>
                    <Text size="xs" c="dimmed" ta="right">
                      {dayjs(event.at).format("L LTS")} - {event.actorEmail}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>
      )}
    </Modal>
  )
}
