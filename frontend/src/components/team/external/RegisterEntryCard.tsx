import {
  ActionIcon,
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core"
import dayjs from "dayjs"
import { useRef, useState } from "react"
import {
  TbCertificate,
  TbFileZip,
  TbListDetails,
  TbFingerprint,
} from "react-icons/tb"
import useTranslate from "../../../hooks/useTranslate.hook"
import type { ExternalIssuance } from "../../../services/teamExternal.service"
import { saveBlobToDevice } from "../../../utils/saveBlob.util"
import toast from "../../../utils/toast.util"

export const contractorLabel = (row: ExternalIssuance) =>
  row.contractorName
    ? `${row.contractorName} (${row.contractorEmail})`
    : row.contractorEmail

/**
 * Certificate and evidence bundle downloads of register entries, wherever
 * they are fetched from: the team settings or the platform evidence vault.
 */
export function useRegisterDownloads(fetchers: {
  certificate: (_row: ExternalIssuance) => Promise<Blob>
  evidence: (_row: ExternalIssuance) => Promise<Blob>
}) {
  const t = useTranslate()
  const [downloading, setDownloading] = useState<string | null>(null)
  const activeDownload = useRef(false)
  const save = async (
    row: ExternalIssuance,
    kind: "certificate" | "evidence",
  ) => {
    if (activeDownload.current) return
    activeDownload.current = true
    setDownloading(`${row.id}:${kind}`)
    const stem = `${dayjs(row.issuedAt).format("YYYY-MM-DD")}-${row.id.slice(0, 8)}`
    try {
      await saveBlobToDevice(
        await fetchers[kind](row),
        kind === "certificate"
          ? `certificat-${stem}.pdf`
          : `dossier-de-preuve-${stem}.zip`,
      )
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          ["NotAllowedError", "AbortError"].includes(error.name)
        )
      )
        toast.error(t("team.audit.certificate.error"))
    } finally {
      activeDownload.current = false
      setDownloading(null)
    }
  }
  return {
    busy: downloading !== null,
    isDownloading: (row: ExternalIssuance, kind: "certificate" | "evidence") =>
      downloading === `${row.id}:${kind}`,
    certificate: (row: ExternalIssuance) => save(row, "certificate"),
    evidence: (row: ExternalIssuance) => save(row, "evidence"),
  }
}

/** One register entry: who received which copy, and its evidence. */
export default function RegisterEntryCard({
  row,
  title,
  downloads,
  onJournal,
  onPatternExport,
  exportingPattern,
}: {
  row: ExternalIssuance
  // Decrypted with the team audit key, null when it cannot be.
  title: string | null
  downloads: ReturnType<typeof useRegisterDownloads>
  onJournal: () => void
  onPatternExport?: () => void
  exportingPattern?: boolean
}) {
  const t = useTranslate()
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" wrap="nowrap" align="start">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
            {title ?? t("team.audit.untitled")}
          </Text>
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {t("team.audit.row", {
              contractor: contractorLabel(row),
              date: dayjs(row.issuedAt).format("L LT"),
              issuer: row.issuerEmail,
              pages: row.pageCount,
            })}
          </Text>
          <Group gap={6}>
            <Badge
              size="xs"
              variant="light"
              color={row.timestampedAt ? "teal" : "gray"}
            >
              {t(
                row.timestampedAt
                  ? "team.audit.timestamped"
                  : "team.audit.notTimestamped",
              )}
            </Badge>
            <Badge
              size="xs"
              variant="light"
              color={row.copyAvailable ? "blue" : "gray"}
            >
              {t(
                row.copyAvailable
                  ? "team.audit.copyOnline"
                  : "team.audit.copyWithdrawn",
              )}
            </Badge>
          </Group>
        </Stack>
        <Group gap={4} wrap="nowrap">
          {onPatternExport && (
            <Tooltip label={t("team.audit.pattern.download")}>
              <ActionIcon
                variant="subtle"
                aria-label={t("team.audit.pattern.download")}
                loading={exportingPattern}
                onClick={onPatternExport}
              >
                <TbFingerprint size={18} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={t("team.audit.certificate.download")}>
            <ActionIcon
              variant="subtle"
              aria-label={t("team.audit.certificate.download")}
              loading={downloads.isDownloading(row, "certificate")}
              disabled={downloads.busy}
              onClick={() => downloads.certificate(row)}
            >
              <TbCertificate size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("team.audit.evidence.download")}>
            <ActionIcon
              variant="subtle"
              aria-label={t("team.audit.evidence.download")}
              loading={downloads.isDownloading(row, "evidence")}
              disabled={downloads.busy}
              onClick={() => downloads.evidence(row)}
            >
              <TbFileZip size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("team.audit.journal.open")}>
            <ActionIcon
              variant="subtle"
              aria-label={t("team.audit.journal.open")}
              onClick={onJournal}
            >
              <TbListDetails size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </Paper>
  )
}
