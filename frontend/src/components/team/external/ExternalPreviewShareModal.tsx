import { visibleCopyToken } from "../../../utils/visibleCopyMark.util"
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Paper,
  TextInput,
  Group,
  Modal,
  Progress,
  Select,
  Stack,
  Text,
} from "@mantine/core"
import { startAuthentication } from "@simplewebauthn/browser"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import dayjs from "dayjs"
import { useEffect, useRef, useState } from "react"
import { useIntl } from "react-intl"
import { TbEyeCheck, TbFingerprint, TbLock, TbTrash } from "react-icons/tb"
import useTranslate from "../../../hooks/useTranslate.hook"
import { fetchFilePreviewSource } from "../../../services/share.service"
import teamExternalService from "../../../services/teamExternal.service"
import { resolveFileMimeType } from "../../../utils/filePreview.util"
import {
  encryptExternalManifest,
  encryptExternalPage,
  EXTERNAL_MANIFEST_VERSION,
  generatePreviewKeyBytes,
  importPreviewKey,
  wrapPreviewKeyForContractor,
} from "../../../utils/externalPreviewCrypto.util"
import {
  buildWatermark,
  externalPreviewKind,
} from "../../../utils/externalPreviewLayout.util"
import { TEAM_PROFILE_LIMITS } from "../../../utils/fileMetadata.util"
import {
  useSaveTeamProfile,
  useTeamProfile,
} from "../../../utils/teamProfile.util"
import { ExternalPreviewError } from "../../../utils/externalPreviewRaster.util"
import { markPattern, newMarkId } from "../../../utils/forensicMark.util"
import { hashPreviewSource, sha256Hex } from "../../../utils/sha256Stream.util"
import {
  encryptRegisterLabel,
  loadTeamAuditKey,
} from "../../../utils/teamAudit.util"
import ApprovalPasskeyRequired, {
  useAccountPasskeys,
} from "./ApprovalPasskeyRequired"

export type ExternalShareFile = {
  id: string
  shareId: string
  name: string
  isE2EEncrypted: boolean
}

type Phase =
  | { kind: "idle" }
  | { kind: "rendering"; pages: number; done?: number; total?: number }
  | { kind: "sealing" }
  | { kind: "approving" }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "done"; pages: number }
  | { kind: "error"; message: string }

const ERROR_KEYS: Record<string, string> = {
  unsupported: "team.external.share.error.unsupported",
  too_many_pages: "team.external.share.error.tooManyPages",
  too_large: "team.external.share.error.tooLarge",
  browser_unsupported: "team.external.share.error.browser",
  external_keys_missing: "team.external.share.error.keys",
  approval_passkey_required: "team.external.share.error.passkey",
  approval_cancelled: "team.external.share.error.approvalCancelled",
  team_key_unavailable: "team.external.share.error.teamKey",
}

export function canShareWithContractor(fileName: string) {
  return externalPreviewKind(resolveFileMimeType(fileName)) !== null
}

export default function ExternalPreviewShareModal({
  opened,
  onClose,
  teamId,
  file,
  teamKeyB64,
}: {
  opened: boolean
  onClose: () => void
  teamId: string
  file: ExternalShareFile | null
  teamKeyB64: string | null
}) {
  const t = useTranslate()
  const intl = useIntl()
  const queryClient = useQueryClient()
  const [seatId, setSeatId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const controller = useRef<AbortController | null>(null)

  // Company details of the team, prefilled and editable for this preview.
  const { data: teamProfile } = useTeamProfile(teamId, opened)
  const saveTeamProfile = useSaveTeamProfile(teamId)
  const [companyName, setCompanyName] = useState("")
  const [mention, setMention] = useState("")
  const [details, setDetails] = useState("")
  const [rememberProfile, setRememberProfile] = useState(false)
  useEffect(() => {
    if (!opened) return
    setCompanyName(teamProfile?.profile?.companyName ?? "")
    setMention(teamProfile?.profile?.mention ?? "")
    setDetails(teamProfile?.profile?.details ?? "")
    setRememberProfile(false)
  }, [opened, teamProfile])
  const profileChanged =
    companyName.trim() !== (teamProfile?.profile?.companyName ?? "") ||
    mention.trim() !== (teamProfile?.profile?.mention ?? "") ||
    details.trim() !== (teamProfile?.profile?.details ?? "")

  const { data: seatList } = useQuery({
    queryKey: ["team-external-seats", teamId],
    queryFn: () => teamExternalService.listSeats(teamId),
    enabled: opened && !!teamId,
  })
  const activeSeats = (seatList?.seats ?? []).filter(
    (seat) => seat.status === "ACTIVE",
  )
  const { data: previews } = useQuery({
    queryKey: ["team-external-previews", teamId],
    queryFn: () => teamExternalService.listPreviews(teamId),
    enabled: opened && !!teamId,
  })
  const existingCopies = (previews ?? []).filter(
    (preview) =>
      preview.sourceFileId === file?.id && preview.status === "READY",
  )
  const seatLabel = (seatId: string) => {
    const seat = seatList?.seats.find((candidate) => candidate.id === seatId)
    return seat?.displayName || seat?.email || ""
  }
  const removeCopy = useMutation({
    mutationFn: (previewId: string) =>
      teamExternalService.deletePreview(teamId, previewId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["team-external-previews", teamId],
      })
      void queryClient.invalidateQueries({
        queryKey: ["team-external-seats", teamId],
      })
    },
  })

  useEffect(() => {
    if (!opened) {
      controller.current?.abort()
      setPhase({ kind: "idle" })
      setSeatId(null)
    }
  }, [opened])

  useEffect(() => {
    if (opened && !seatId && activeSeats.length === 1) {
      setSeatId(activeSeats[0].id)
    }
  }, [opened, seatId, activeSeats])

  const busy =
    phase.kind === "rendering" ||
    phase.kind === "sealing" ||
    phase.kind === "approving" ||
    phase.kind === "uploading"
  const { data: passkeys } = useAccountPasskeys(opened)
  const hasPasskey =
    (passkeys?.passkeys.length ?? 0) + (passkeys?.signingPasskeys ?? 0) > 0

  const share = async () => {
    if (!file || !seatId) return
    const abort = new AbortController()
    controller.current = abort
    const keyBytes = generatePreviewKeyBytes()
    let auditKey: Uint8Array | null = null
    let createdPreviewId: string | null = null
    try {
      setPhase({ kind: "rendering", pages: 0 })
      const recipient = await teamExternalService.getSeatKeys(teamId, seatId)
      // Every copy carries its own invisible mark, derived from the team
      // audit key that only administrators can unwrap.
      auditKey = await loadTeamAuditKey(teamId, { create: true })
      if (!auditKey) throw new Error("team_key_unavailable")
      const markId = newMarkId()
      const source = await fetchFilePreviewSource(
        file.shareId,
        file.id,
        file.isE2EEncrypted ? teamKeyB64 : null,
        abort.signal,
      )
      const company = companyName.trim()
        ? {
            companyName: companyName.trim(),
            mention: mention.trim() || undefined,
            details: details.trim() || undefined,
          }
        : undefined
      if (company && rememberProfile && teamProfile?.keyAvailable) {
        await saveTeamProfile(company)
      }
      const watermark = {
        ...buildWatermark({
          name: recipient.displayName,
          email: recipient.email,
          date: new Date(),
          company,
          defaultMention: t("team.external.watermark.defaultMention"),
        }),
        forensic: await markPattern(auditKey, markId),
        robustForensic: true,
        visibleToken: await visibleCopyToken(auditKey, markId),
      }
      // The renderer is heavy (pdf.js, Office parsers): load it on demand.
      const { renderExternalPreview } = await import("./renderExternalPreview")
      const pages = await renderExternalPreview({
        source,
        mimeType: resolveFileMimeType(file.name),
        locale: intl.locale,
        watermark,
        signal: abort.signal,
        onProgress: (count, done, total) =>
          setPhase({ kind: "rendering", pages: count, done, total }),
      })

      const previewId = crypto.randomUUID()
      const key = await importPreviewKey(keyBytes)
      const wrapping = await wrapPreviewKeyForContractor(keyBytes, recipient)
      const encryptedManifest = await encryptExternalManifest(key, previewId, {
        v: EXTERNAL_MANIFEST_VERSION,
        title: file.name,
        watermark: watermark.text,
        createdAt: new Date().toISOString(),
        pages: pages.map((page) => ({
          width: page.width,
          height: page.height,
          ...(page.label ? { label: page.label } : {}),
        })),
      })
      // What the passkey signs: the original, every page as shown and as
      // stored. The server refuses the copy if a stored page differs.
      setPhase({ kind: "sealing" })
      const sourceSha256 = await hashPreviewSource(source, abort.signal)
      const sealedPages: Uint8Array[] = []
      const pageHashes = []
      for (let index = 0; index < pages.length; index++) {
        abort.signal.throwIfAborted()
        const image = new Uint8Array(await pages[index].image.arrayBuffer())
        const sealed = await encryptExternalPage(key, previewId, index, image)
        sealedPages.push(sealed)
        pageHashes.push({
          plainSha256: await sha256Hex(image),
          cipherSha256: await sha256Hex(sealed),
          width: pages[index].width,
          height: pages[index].height,
        })
      }
      await teamExternalService.createPreview(teamId, {
        id: previewId,
        seatId,
        sourceFileId: file.id,
        pageCount: pages.length,
        encryptedManifest,
        ...wrapping,
      })
      createdPreviewId = previewId
      const ceremony = await teamExternalService.prepareIssuance(
        teamId,
        previewId,
        {
          markId,
          sourceSha256,
          pages: pageHashes,
          visibleMarkAlgorithm: "privcloud:visible-copy:v1",
          robustMarkAlgorithm: "privcloud:forensic-multiscale:v2",
        },
      )
      setPhase({ kind: "approving" })
      let assertion
      try {
        assertion = await startAuthentication({
          optionsJSON: ceremony.options as unknown as Parameters<
            typeof startAuthentication
          >[0]["optionsJSON"],
        })
      } catch {
        throw new Error("approval_cancelled")
      }
      await teamExternalService.approveIssuance(teamId, previewId, {
        challengeId: ceremony.challengeId,
        response: assertion,
        encryptedLabel: await encryptRegisterLabel(
          auditKey,
          teamId,
          previewId,
          file.name,
        ),
      })
      for (let index = 0; index < sealedPages.length; index++) {
        abort.signal.throwIfAborted()
        setPhase({ kind: "uploading", done: index, total: pages.length })
        await teamExternalService.uploadPage(
          teamId,
          previewId,
          index,
          sealedPages[index],
          abort.signal,
        )
      }
      await teamExternalService.completePreview(teamId, previewId)
      createdPreviewId = null
      setPhase({ kind: "done", pages: pages.length })
      void queryClient.invalidateQueries({
        queryKey: ["team-external-seats", teamId],
      })
      void queryClient.invalidateQueries({
        queryKey: ["team-external-previews", teamId],
      })
      void queryClient.invalidateQueries({
        queryKey: ["team-external-issuances", teamId],
      })
    } catch (error) {
      // An unfinished copy is withdrawn at once rather than left for the
      // hourly purge.
      if (createdPreviewId) {
        void teamExternalService
          .deletePreview(teamId, createdPreviewId)
          .catch(() => undefined)
      }
      if (abort.signal.aborted) return
      const code =
        error instanceof ExternalPreviewError
          ? error.code
          : ((error as { response?: { data?: { error?: string } } })?.response
              ?.data?.error ??
            (error as Error)?.message ??
            "")
      setPhase({
        kind: "error",
        message: t(ERROR_KEYS[code] ?? "team.external.share.error.generic"),
      })
    } finally {
      keyBytes.fill(0)
      auditKey?.fill(0)
    }
  }

  const progressValue =
    phase.kind === "uploading"
      ? (phase.done / Math.max(1, phase.total)) * 100
      : phase.kind === "rendering" && phase.total
        ? ((phase.done ?? 0) / phase.total) * 100
        : undefined

  return (
    <Modal
      opened={opened}
      onClose={() => {
        controller.current?.abort()
        onClose()
      }}
      title={t("team.external.share.title")}
      size="lg"
      closeOnClickOutside={!busy}
    >
      <Stack gap="md">
        <Text size="sm">{t("team.external.share.description")}</Text>
        {file && (
          <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
            {file.name}
          </Text>
        )}
        {existingCopies.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600}>
              {t("team.external.share.existing")}
            </Text>
            {existingCopies.map((copy) => (
              <Group
                key={copy.id}
                justify="space-between"
                gap="xs"
                wrap="nowrap"
              >
                <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                  {t("team.external.share.existingCopy", {
                    name: seatLabel(copy.seatId),
                    date: dayjs(copy.createdAt).format("L LT"),
                  })}
                </Text>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={t("team.external.seats.removeCopy")}
                  loading={
                    removeCopy.isPending && removeCopy.variables === copy.id
                  }
                  onClick={() => removeCopy.mutate(copy.id)}
                >
                  <TbTrash size={14} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
        {activeSeats.length === 0 ? (
          <Alert color="orange" icon={<TbLock size={18} />}>
            {t("team.external.share.noSeat")}
          </Alert>
        ) : (
          <Select
            label={t("team.external.share.seat")}
            data={activeSeats.map((seat) => ({
              value: seat.id,
              label: seat.displayName
                ? `${seat.displayName} (${seat.email})`
                : seat.email,
            }))}
            value={seatId}
            onChange={setSeatId}
            disabled={busy}
            allowDeselect={false}
          />
        )}
        <Paper withBorder p="sm">
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              {t("team.external.watermark.legend")}
            </Text>
            <TextInput
              size="xs"
              label={t("team.profile.companyName")}
              value={companyName}
              maxLength={TEAM_PROFILE_LIMITS.companyName}
              onChange={(event) => setCompanyName(event.currentTarget.value)}
              disabled={busy}
            />
            <Group grow align="end" gap="xs">
              <TextInput
                size="xs"
                label={t("team.profile.mention")}
                placeholder={t("team.external.watermark.defaultMention")}
                value={mention}
                maxLength={TEAM_PROFILE_LIMITS.mention}
                onChange={(event) => setMention(event.currentTarget.value)}
                disabled={busy}
              />
              <TextInput
                size="xs"
                label={t("team.profile.details")}
                value={details}
                maxLength={TEAM_PROFILE_LIMITS.details}
                onChange={(event) => setDetails(event.currentTarget.value)}
                disabled={busy}
              />
            </Group>
            <Text size="xs" c="dimmed">
              {t("team.external.watermark.hint")}
            </Text>
            {teamProfile?.keyAvailable &&
              companyName.trim() &&
              profileChanged && (
                <Checkbox
                  size="xs"
                  checked={rememberProfile}
                  onChange={(event) =>
                    setRememberProfile(event.currentTarget.checked)
                  }
                  label={t("team.external.watermark.remember")}
                />
              )}
          </Stack>
        </Paper>
        <ApprovalPasskeyRequired />
        {phase.kind === "rendering" && (
          <Text size="sm" c="dimmed">
            {t("team.external.share.rendering", { count: phase.pages })}
          </Text>
        )}
        {phase.kind === "sealing" && (
          <Text size="sm" c="dimmed">
            {t("team.external.share.sealing")}
          </Text>
        )}
        {phase.kind === "approving" && (
          <Alert color="blue" icon={<TbFingerprint size={18} />}>
            {t("team.external.share.approving")}
          </Alert>
        )}
        {phase.kind === "uploading" && (
          <Text size="sm" c="dimmed">
            {t("team.external.share.uploading", {
              done: phase.done + 1,
              total: phase.total,
            })}
          </Text>
        )}
        {busy && (
          <Progress
            value={progressValue ?? 100}
            animated={progressValue === undefined}
          />
        )}
        {phase.kind === "done" && (
          <Alert color="teal" icon={<TbEyeCheck size={18} />}>
            {t("team.external.share.done", { count: phase.pages })}
          </Alert>
        )}
        {phase.kind === "error" && <Alert color="red">{phase.message}</Alert>}
        <Group justify="flex-end">
          <Button
            variant="default"
            onClick={() => {
              controller.current?.abort()
              onClose()
            }}
          >
            {phase.kind === "done"
              ? t("common.button.close")
              : t("common.button.cancel")}
          </Button>
          {phase.kind !== "done" && (
            <Button
              onClick={share}
              loading={busy}
              disabled={
                !file || !seatId || activeSeats.length === 0 || !hasPasskey
              }
            >
              {t("team.external.share.submit")}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
