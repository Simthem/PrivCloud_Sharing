import {
  Alert,
  Anchor,
  Button,
  Divider,
  FileButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
} from "@mantine/core"
import { useQuery } from "@tanstack/react-query"
import { modals } from "@mantine/modals"
import dayjs from "dayjs"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { TbPhotoSearch, TbShieldCheck } from "react-icons/tb"
import useTranslate from "../../../hooks/useTranslate.hook"
import teamExternalService, {
  type ExternalIssuance,
} from "../../../services/teamExternal.service"
import {
  MARK_DETECTION_THRESHOLD,
  MARK_SCORE_CEILING,
  markPattern,
  type MarkDetection,
} from "../../../utils/forensicMark.util"
import { createForensicAnalyzer } from "../../../utils/forensicAnalysis.util"
import { createPhotoRegistrar } from "../../../utils/photoRegistration.util"
import {
  referenceDigest,
  referenceImages,
} from "../../../utils/referenceImages.util"
import { forensicDecision } from "../../../utils/forensicDecision.util"
import { saveBlobToDevice } from "../../../utils/saveBlob.util"
import { exportCopyPattern } from "../../../utils/copyPatternExport.util"
import toast from "../../../utils/toast.util"
import { visibleCopyToken } from "../../../utils/visibleCopyMark.util"
import type { ForensicAnalysis } from "../../../utils/forensicAnalysis.util"
import {
  decryptRegisterLabel,
  loadTeamAuditKey,
} from "../../../utils/teamAudit.util"
import {
  isPdf,
  SuspectFileError,
  suspectImages,
} from "../../../utils/suspectImages.util"
import AuditJournalModal from "./AuditJournalModal"
import RegisterEntryCard, {
  contractorLabel,
  useRegisterDownloads,
} from "./RegisterEntryCard"

type RegisterRow = ExternalIssuance & { title: string | null }

type Verdict =
  | {
      kind: "match"
      detection: MarkDetection
      minimumScore?: number
      row: RegisterRow
      page?: number
    }
  | { kind: "none" }
  | { kind: "visible_marker"; markId: string; row: RegisterRow }
  | { kind: "ambiguous"; compatibleCount: number }
  | { kind: "error"; message: string }

/**
 * Register of the copies issued to contractors, their certificates and
 * journals, and the check of a suspect image against their invisible marks.
 * Titles are decrypted here, and a suspect image never leaves the browser.
 */
export default function TeamAuditPanel({ teamId }: { teamId: string }) {
  const t = useTranslate()
  const [journalFor, setJournalFor] = useState<RegisterRow | null>(null)
  const [checking, setChecking] = useState(false)
  const [exportingPattern, setExportingPattern] = useState<string | null>(null)
  const patternBusy = useRef(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const analysisAbort = useRef<AbortController | null>(null)
  const [suspectFile, setSuspectFile] = useState<File | null>(null)
  const [referenceUsed, setReferenceUsed] = useState(false)
  const previousChecks = useRef<{
    signature: string
    results: { analysis: ForensicAnalysis; page?: number }[]
  } | null>(null)
  useEffect(() => () => analysisAbort.current?.abort(), [])
  const downloads = useRegisterDownloads({
    certificate: (row) =>
      teamExternalService.downloadCertificate(teamId, row.id),
    evidence: (row) => teamExternalService.downloadEvidence(teamId, row.id),
  })

  const { data: register, isLoading } = useQuery({
    queryKey: ["team-external-issuances", teamId],
    queryFn: async (): Promise<RegisterRow[]> => {
      const rows = await teamExternalService.listIssuances(teamId)
      const auditKey = await loadTeamAuditKey(teamId, { create: false }).catch(
        () => null,
      )
      try {
        return await Promise.all(
          rows.map(async (row) => ({
            ...row,
            title: auditKey
              ? await decryptRegisterLabel(
                  auditKey,
                  teamId,
                  row.previewId,
                  row.encryptedLabel,
                )
              : null,
          })),
        )
      } finally {
        auditKey?.fill(0)
      }
    },
  })

  const { data: journal } = useQuery({
    queryKey: ["team-external-journal", teamId, journalFor?.previewId],
    queryFn: () =>
      teamExternalService.getJournal(teamId, journalFor!.previewId),
    enabled: !!journalFor,
  })

  const checkImage = async (file: File | null) => {
    if (!file || !register) return
    setSuspectFile(file)
    setReferenceUsed(false)
    previousChecks.current = null
    setChecking(true)
    setVerdict(null)
    analysisAbort.current?.abort()
    const controller = new AbortController()
    analysisAbort.current = controller
    let auditKey: Uint8Array | null = null
    let analyzer: Awaited<ReturnType<typeof createForensicAnalyzer>> | undefined
    try {
      auditKey = await loadTeamAuditKey(teamId, { create: false })
      if (!auditKey || register.length === 0) {
        setVerdict({ kind: "none" })
        return
      }
      const key = auditKey
      if (register.length > 1000) throw new Error("Candidate budget exceeded")
      const candidates = await Promise.all(
        register.map(async (row) => ({
          markId: row.markId,
          pattern: await markPattern(key, row.markId),
          visibleToken: await visibleCopyToken(key, row.markId),
          robust:
            row.robustMarkAlgorithm === "privcloud:forensic-multiscale:v2",
        })),
      )
      analyzer = await createForensicAnalyzer(
        candidates,
        controller.signal,
        () => {
          if (!controller.signal.aborted)
            setProgress(t("team.audit.check.fragment"))
        },
      )
      // Every page contributes, so a later ambiguity cannot be hidden by a match.
      let analysed = 0
      const results: { analysis: ForensicAnalysis; page?: number }[] = []
      for await (const image of suspectImages(file, controller.signal)) {
        analysed++
        if (image.page) {
          setProgress(t("team.audit.check.progress", { page: image.page }))
        }
        controller.signal.throwIfAborted()
        results.push({
          analysis: await analyzer.analyse(image.pixels),
          page: image.page,
        })
      }
      const decision = forensicDecision(results)
      controller.signal.throwIfAborted()
      previousChecks.current = {
        signature: register
          .map((row) => row.markId + row.robustMarkAlgorithm)
          .sort()
          .join(","),
        results,
      }
      const row =
        decision.kind === "match" || decision.kind === "visible_marker"
          ? register.find(
              (entry) =>
                entry.markId ===
                (decision.kind === "match"
                  ? decision.detection.markId
                  : decision.markId),
            )
          : undefined
      setVerdict(
        decision.kind === "match" || decision.kind === "visible_marker"
          ? row
            ? { ...decision, row }
            : { kind: "none" }
          : analysed === 0 && isPdf(file)
            ? { kind: "error", message: t("team.audit.check.emptyPdf") }
            : decision,
      )
    } catch (error) {
      if (controller.signal.aborted) return
      setVerdict({
        kind: "error",
        message: t(
          error instanceof SuspectFileError && error.code === "too_large"
            ? "team.audit.check.tooLarge"
            : "team.audit.check.error",
        ),
      })
    } finally {
      analyzer?.close()
      auditKey?.fill(0)
      if (analysisAbort.current === controller) {
        analysisAbort.current = null
        setProgress(null)
        setChecking(false)
      }
    }
  }

  const checkReference = async (original: File | null) => {
    if (!original || !suspectFile || !register || checking) return
    const previous = previousChecks.current
    const signature = register
      .map((row) => row.markId + row.robustMarkAlgorithm)
      .sort()
      .join(",")
    if (!previous || previous.signature !== signature) {
      toast.error(t("team.audit.reference.recheck"))
      return
    }
    analysisAbort.current?.abort()
    const controller = new AbortController()
    analysisAbort.current = controller
    const deadline = setTimeout(() => controller.abort("deadline"), 180_000)
    setChecking(true)
    setProgress(t("team.audit.reference.preparing"))
    let key: Uint8Array | null = null
    let analyzer: Awaited<ReturnType<typeof createForensicAnalyzer>> | undefined
    let registrar: Awaited<ReturnType<typeof createPhotoRegistrar>> | undefined
    try {
      const digest = await referenceDigest(original, controller.signal)
      if (!register.some((row) => row.sourceSha256 === digest)) {
        toast.error(t("team.audit.reference.mismatch"))
        return
      }
      key = await loadTeamAuditKey(teamId, { create: false })
      if (!key) throw new Error("Audit key unavailable")
      const auditKey = key
      const candidates = await Promise.all(
        register.map(async (row) => ({
          markId: row.markId,
          pattern: await markPattern(auditKey, row.markId),
          visibleToken: await visibleCopyToken(auditKey, row.markId),
          robust:
            row.robustMarkAlgorithm === "privcloud:forensic-multiscale:v2",
        })),
      )
      analyzer = await createForensicAnalyzer(candidates, controller.signal)
      for await (const image of suspectImages(suspectFile, controller.signal)) {
        registrar = await createPhotoRegistrar(image.pixels, controller.signal)
        break
      }
      if (!registrar) throw new Error("No photograph to register")
      const results = [...previous.results]
      let geometries = 0
      for await (const reference of referenceImages(
        original,
        controller.signal,
      )) {
        setProgress(
          t("team.audit.reference.progress", {
            page: reference.page,
            total: reference.total,
          }),
        )
        const registered = await registrar.register(reference.pixels)
        if (!registered) continue
        geometries++
        results.push({
          analysis: await analyzer.analyse(registered.pixels),
          page: reference.page,
        })
      }
      controller.signal.throwIfAborted()
      const decision = forensicDecision(results)
      const row =
        decision.kind === "match" || decision.kind === "visible_marker"
          ? register.find(
              (entry) =>
                entry.markId ===
                (decision.kind === "match"
                  ? decision.detection.markId
                  : decision.markId),
            )
          : undefined
      setReferenceUsed(geometries > 0)
      previousChecks.current = { signature, results }
      if (decision.kind === "match" || decision.kind === "visible_marker")
        setVerdict(
          row && row.sourceSha256 === digest
            ? { ...decision, row }
            : { kind: "none" },
        )
      else setVerdict(decision)
      if (!geometries) toast.error(t("team.audit.reference.noGeometry"))
    } catch {
      if (!controller.signal.aborted || controller.signal.reason === "deadline")
        toast.error(
          t(
            controller.signal.reason === "deadline"
              ? "team.audit.reference.timeout"
              : "team.audit.reference.error",
          ),
        )
    } finally {
      clearTimeout(deadline)
      registrar?.close()
      analyzer?.close()
      key?.fill(0)
      if (analysisAbort.current === controller) {
        analysisAbort.current = null
        setChecking(false)
        setProgress(null)
      }
    }
  }

  const downloadPattern = async (row: ExternalIssuance) => {
    if (patternBusy.current) return
    patternBusy.current = true
    setExportingPattern(row.id)
    let key: Uint8Array | null = null
    try {
      const permission = await teamExternalService.authorizePatternExport(
        teamId,
        row.id,
      )
      if (
        permission.markId !== row.markId ||
        permission.robustMarkAlgorithm !== row.robustMarkAlgorithm
      )
        throw new Error("Pattern export does not match the authorized copy")
      key = await loadTeamAuditKey(teamId, { create: false })
      if (!key) throw new Error("Audit key unavailable")
      const json = await exportCopyPattern(
        key,
        row.markId,
        row.robustMarkAlgorithm,
      )
      await saveBlobToDevice(
        new Blob([json], { type: "application/json" }),
        `diagnostic-motif-${row.markId.slice(0, 8)}.json`,
      )
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          ["NotAllowedError", "AbortError"].includes(error.name)
        )
      )
        toast.error(t("team.audit.pattern.error"))
    } finally {
      key?.fill(0)
      patternBusy.current = false
      setExportingPattern(null)
    }
  }

  return (
    <Paper withBorder p="lg" mb="lg">
      <Group mb="md">
        <TbShieldCheck size={20} />
        <Title order={4}>{t("team.audit.title")}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {t("team.audit.hint")}
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        {t("team.audit.download.passkeyHint")}
      </Text>

      {isLoading ? (
        <Loader size="sm" />
      ) : !register?.length ? (
        <Text size="sm" c="dimmed">
          {t("team.audit.empty")}
        </Text>
      ) : (
        <ScrollArea.Autosize mah={420}>
          <Stack gap="xs">
            {register.map((row) => (
              <RegisterEntryCard
                key={row.id}
                row={row}
                title={row.title}
                downloads={downloads}
                onJournal={() => setJournalFor(row)}
                exportingPattern={exportingPattern === row.id}
                onPatternExport={() =>
                  modals.openConfirmModal({
                    title: t("team.audit.pattern.download"),
                    children: (
                      <Text size="sm">{t("team.audit.pattern.warning")}</Text>
                    ),
                    labels: {
                      confirm: t("team.audit.pattern.confirm"),
                      cancel: t("common.button.cancel"),
                    },
                    onConfirm: () => {
                      void downloadPattern(row)
                    },
                  })
                }
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <Divider my="md" />
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          {t("team.audit.check.title")}
        </Text>
        <Text size="xs" c="dimmed">
          {t("team.audit.check.hint")}
        </Text>
        <Anchor
          component={Link}
          href="/blog/verifier-preuves-partage-fichiers"
          prefetch={false}
          size="sm"
        >
          {t("team.audit.verificationGuide")}
        </Anchor>
        {referenceUsed && (
          <Text size="xs" c="dimmed">
            {t("team.audit.reference.used")}
          </Text>
        )}
        <Group>
          <FileButton
            onChange={checkImage}
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,application/pdf,.pdf"
          >
            {(props) => (
              <Button
                {...props}
                size="xs"
                variant="light"
                leftSection={<TbPhotoSearch size={14} />}
                loading={checking}
                disabled={!register?.length}
              >
                {t("team.audit.check.button")}
              </Button>
            )}
          </FileButton>
          {suspectFile && !isPdf(suspectFile) && verdict?.kind === "none" && (
            <FileButton onChange={checkReference} accept="application/pdf,.pdf">
              {(props) => (
                <Button
                  {...props}
                  size="xs"
                  variant="light"
                  loading={checking}
                  disabled={
                    checking || !register?.some((row) => row.sourceSha256)
                  }
                >
                  {t("team.audit.reference.button")}
                </Button>
              )}
            </FileButton>
          )}
          {checking && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => analysisAbort.current?.abort()}
            >
              {t("common.cancel")}
            </Button>
          )}
        </Group>
        {progress && (
          <Text size="xs" c="dimmed">
            {progress}
          </Text>
        )}
        {verdict?.kind === "match" && (
          <Alert color="blue" icon={<TbPhotoSearch size={18} />}>
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {t("team.audit.check.match", {
                  contractor: contractorLabel(verdict.row),
                  date: dayjs(verdict.row.issuedAt).format("L LT"),
                })}
              </Text>
              <Text size="sm">
                {t("team.audit.check.document", {
                  title: verdict.row.title ?? t("team.audit.untitled"),
                })}
              </Text>
              {verdict.page && (
                <Text size="sm">
                  {t("team.audit.check.page", { page: verdict.page })}
                </Text>
              )}
              <Text size="sm">
                {t("team.audit.check.reliability", {
                  level: t(
                    verdict.detection.score >= 2 * MARK_DETECTION_THRESHOLD
                      ? "team.audit.check.level.certain"
                      : "team.audit.check.level.high",
                  ),
                })}
              </Text>
              <Text size="xs" c="dimmed">
                {t("team.audit.check.technical", {
                  score: verdict.detection.score.toFixed(1),
                  threshold: verdict.minimumScore ?? MARK_DETECTION_THRESHOLD,
                  ceiling: MARK_SCORE_CEILING,
                  scale: Math.round(verdict.detection.scale * 100),
                })}
              </Text>
            </Stack>
          </Alert>
        )}
        {verdict?.kind === "none" && (
          <Alert color="gray">{t("team.audit.check.none")}</Alert>
        )}
        {verdict?.kind === "visible_marker" && (
          <Alert color="blue" icon={<TbPhotoSearch size={18} />}>
            <Text size="sm">
              {t("team.audit.check.visibleMarker", {
                contractor: contractorLabel(verdict.row),
              })}
            </Text>
            <Text size="xs" c="dimmed">
              {t("team.audit.check.visibleMarker.limit")}
            </Text>
          </Alert>
        )}
        {verdict?.kind === "ambiguous" && (
          <Alert color="orange" icon={<TbPhotoSearch size={18} />}>
            {t("team.audit.check.ambiguous", {
              count: verdict.compatibleCount,
            })}
          </Alert>
        )}
        {verdict?.kind === "error" && (
          <Alert color="orange">{verdict.message}</Alert>
        )}
      </Stack>

      <Divider my="md" />
      <Text size="xs" c="dimmed">
        {t("team.audit.passkeys.hint")}{" "}
        <Anchor component={Link} href="/account#passkeys" size="xs">
          {t("team.audit.passkeys.manage")}
        </Anchor>
      </Text>

      <AuditJournalModal
        opened={!!journalFor}
        onClose={() => setJournalFor(null)}
        journal={journal}
        onDiagnostic={async () => {
          const blob = await teamExternalService.getJournalDiagnostic(teamId)
          await saveBlobToDevice(blob, "diagnostic-journal-prive.json")
        }}
      />
    </Paper>
  )
}
