import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useState, useEffect } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Timeline,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  TbBell,
  TbCheck,
  TbCopy,
  TbDownload,
  TbFileDescription,
  TbFileOff,
  TbLink,
  TbLock,
  TbMail,
  TbShieldCheck,
  TbX,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import signingService from "../../services/signing.service";
import shareService from "../../services/share.service";
import teamService from "../../services/team.service";
import toast from "../../utils/toast.util";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import {
  importKeyFromBase64,
  exportKeyToBase64,
  decryptFileAuto,
  encryptFile,
  getUserKey,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";

const statusColors: Record<string, string> = {
  PENDING: "yellow",
  VIEWED: "blue",
  SIGNED: "green",
  REJECTED: "red",
  PARTIAL: "blue",
  COMPLETED: "green",
  CANCELLED: "gray",
  AWAITING_FINALIZATION: "orange",
};

const statusKeyMap: Record<string, string> = {
  PENDING: "signing.status.pending",
  VIEWED: "signing.status.viewed",
  SIGNED: "signing.status.signed",
  PARTIAL: "signing.status.partial",
  COMPLETED: "signing.status.completed",
  CANCELLED: "signing.status.cancelled",
  REJECTED: "signing.status.rejected",
  AWAITING_FINALIZATION: "signing.status.awaiting-finalization",
};

const SigningDetailPage = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const docId = router.query.id as string;
  const isMobile = useMediaQuery("(max-width: 680px)");
  const t = useTranslate();
  const intl = useIntl();

  const getStatusLabel = (status: string) =>
    statusKeyMap[status] ? t(statusKeyMap[status]) : status;

  const getRoleLabel = (role?: string) => {
    if (role === "SIGNER") return t("signing.role.signer");
    if (role === "APPROVER") return t("signing.role.approver");
    if (role === "CC") return t("signing.role.cc");
    return "-";
  };

  const formatDateTime = (date: string) =>
    new Date(date).toLocaleDateString(intl.locale, {
      day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
    });

  const formatDateShort = (date: string) =>
    new Date(date).toLocaleDateString(intl.locale, {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
    });

  useEffect(() => {
    if (user === null) {
      router.replace(`/auth/signIn?redirect=/signing/${docId}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // E2E key resolution state
  const [e2eKeyB64, setE2eKeyB64] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [autoFinalizeTriggered, setAutoFinalizeTriggered] = useState(false);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["signing.document", docId],
    queryFn: () => signingService.getDocument(docId),
    enabled: !!docId,
  });

  const typedDoc = doc as any;

  // Resolve E2E key when document is E2E encrypted
  // Path 1: team folder → unwrap team key
  // Path 2: non-team share → resolve via share's e2e-key endpoint (K_master or unwrap reverse share key)
  useEffect(() => {
    if (!typedDoc?.isE2EEncrypted) return;
    if (e2eKeyB64) return; // already resolved
    // Need at least one resolution path
    if (!typedDoc?.teamId && !typedDoc?.shareId) return;

    (async () => {
      try {
        const userKeyB64 = getUserKey();
        if (!userKeyB64) return;
        const masterKey = await importKeyFromBase64(userKeyB64);

        if (typedDoc.teamId) {
          // Path 1: Team folder → derive from team key
          const { wrappedTeamKey } = await teamService.getTeamKey(typedDoc.teamId);
          if (!wrappedTeamKey) return;
          const teamKey = await unwrapReverseShareKey(wrappedTeamKey, masterKey);
          const keyB64 = await exportKeyToBase64(teamKey);
          setE2eKeyB64(keyB64);
        } else if (typedDoc.shareId) {
          // Path 2: Non-team share → use master key or unwrap reverse share key
          const encryptedKey = await shareService.getEncryptedE2eKey(typedDoc.shareId);
          if (encryptedKey) {
            // Reverse share: unwrap the share key with master key
            const shareKey = await unwrapReverseShareKey(encryptedKey, masterKey);
            const keyB64 = await exportKeyToBase64(shareKey);
            setE2eKeyB64(keyB64);
          } else {
            // Normal share: encrypted directly with user's master key
            const keyB64 = await exportKeyToBase64(masterKey);
            setE2eKeyB64(keyB64);
          }
        }
      } catch {
        // Key resolution failed - user may not have access
      }
    })();
  }, [typedDoc?.isE2EEncrypted, typedDoc?.teamId, typedDoc?.shareId, e2eKeyB64]);

  // Auto-finalize E2E documents when key is resolved and status is AWAITING_FINALIZATION
  useEffect(() => {
    if (
      typedDoc?.status === "AWAITING_FINALIZATION" &&
      typedDoc?.isE2EEncrypted &&
      !(typedDoc as any)?.fileDeleted &&
      e2eKeyB64 &&
      !finalizing &&
      !autoFinalizeTriggered
    ) {
      setAutoFinalizeTriggered(true);
      handleFinalizeE2E();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedDoc?.status, e2eKeyB64, finalizing, autoFinalizeTriggered]);

  // E2E finalization:
  //   1. Decrypt original PDF
  //   2. Apply visual signatures (pdf-lib)
  //   3. Send plain PDF to backend for certificate page + PAdES crypto signature
  //   4. Re-encrypt the PAdES-signed result
  //   5. Upload encrypted PDF for storage
  const handleFinalizeE2E = async () => {
    if (!e2eKeyB64 || !docId) return;
    setFinalizing(true);
    try {
      // 1. Download original encrypted PDF
      const encryptedBuf = await signingService.downloadOriginal(docId);

      // 2. Decrypt
      const cryptoKey = await importKeyFromBase64(e2eKeyB64);
      const decryptedBuf = await decryptFileAuto(encryptedBuf, cryptoKey, 5_000_000);

      // 3. Get signatures data from backend
      const sigData = await signingService.getSignaturesForFinalization(docId);

      // 4. Apply visual signatures with pdf-lib
      const { PDFDocument, rgb, StandardFonts, degrees } = await import("pdf-lib");
      const pdfDoc = await PDFDocument.load(decryptedBuf);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const pages = pdfDoc.getPages();
      const firstPage = pages[0];
      const lastPage = pages[pages.length - 1];
      const { width, height } = firstPage.getSize();

      // Add "Bon pour Accord" diagonal watermark on FIRST page if enabled
      if (sigData.addApprovalField) {
        firstPage.drawText("Bon pour Accord", {
          x: width * 0.12,
          y: height * 0.38,
          size: 60,
          font: fontBold,
          color: rgb(0.5, 0.75, 0.5),
          opacity: 0.35,
          rotate: degrees(45),
        });
      }

      // Add "Lu et approuvé" mention if enabled
      const addMention = sigData.addApprovalMention !== false; // default true

      // Add initials at bottom of each page if enabled
      if (sigData.addInitials && sigData.signers?.length) {
        const initialsText = sigData.signers
          .map((s: any) =>
            s.name
              .split(" ")
              .map((w: string) => w[0]?.toUpperCase())
              .join("")
          )
          .join(" / ");
        for (const page of pages) {
          const { width: pw } = page.getSize();
          page.drawText(initialsText, {
            x: pw - 60,
            y: 20,
            size: 8,
            font,
            color: rgb(0.3, 0.3, 0.3),
          });
        }
      }

      // For each signer, embed their signature (bottom-right area)
      const { width: lastW } = lastPage.getSize();
      let yOffset = 120;
      for (const sig of sigData.signers || []) {
        if (!sig.signatureData) continue;

        if (addMention) {
          // "Lu et approuvé" mention
          const dateStr = new Date(sig.signedAt).toLocaleDateString("fr-FR", {
            day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris",
          });
          lastPage.drawText(`Lu et approuvé le ${dateStr}`, {
            x: lastW - 250, y: yOffset + 60, size: 9, font, color: rgb(0, 0, 0),
          });
        }
        lastPage.drawText(sig.name, {
          x: lastW - 250, y: yOffset + 45, size: 10, font: fontBold, color: rgb(0, 0, 0),
        });

        // Embed signature image (PNG base64)
        const sigBytes = Uint8Array.from(
          atob(sig.signatureData.replace(/^data:[^;]+;base64,/, "")),
          (c) => c.charCodeAt(0),
        );
        let sigImage;
        try {
          sigImage = await pdfDoc.embedPng(sigBytes);
        } catch {
          sigImage = await pdfDoc.embedJpg(sigBytes);
        }

        const sigDims = sigImage.scale(0.5);
        lastPage.drawImage(sigImage, {
          x: lastW - 250,
          y: yOffset,
          width: Math.min(sigDims.width, 180),
          height: Math.min(sigDims.height, 40),
        });

        yOffset += 80;
      }

      // 5. Save PDF with visual signatures
      const visuallySignedPdf = await pdfDoc.save();

      // 6. Send to backend for certificate page + PAdES cryptographic signature
      const padesSignedPdf = await signingService.signE2EPdf(
        docId,
        visuallySignedPdf.buffer as ArrayBuffer,
      );

      // 7. Re-encrypt the PAdES-signed PDF
      const reEncrypted = await encryptFile(padesSignedPdf, cryptoKey);

      // 8. Upload encrypted final PDF for storage
      await signingService.finalizeE2E(docId, reEncrypted);

      queryClient.invalidateQueries({ queryKey: ["signing.document", docId] });
      toast.success(t("signing.toast.finalize-success"));
    } catch (err) {
      console.error("E2E finalization error:", err);
      toast.error(t("signing.toast.finalize-error"));
    } finally {
      setFinalizing(false);
    }
  };

  const cancelMutation = useMutation({
    mutationFn: () => signingService.cancelDocument(docId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["signing.document", docId] });
      toast.success(t("signing.toast.request-cancelled"));
    },
    onError: () => toast.error(t("signing.toast.cancel-error")),
  });

  const reminderMutation = useMutation({
    mutationFn: () => signingService.sendReminder(docId),
    onSuccess: () => toast.success(t("signing.toast.reminder-sent")),
    onError: () => toast.error(t("signing.toast.reminder-error")),
  });

  const handleDownload = async () => {
    try {
      const blob = await signingService.downloadSigned(docId);
      let finalBlob = blob;

      // If E2E encrypted and we have the key, decrypt before saving
      if (typedDoc?.isE2EEncrypted && e2eKeyB64) {
        const encryptedBuf = await blob.arrayBuffer();
        const cryptoKey = await importKeyFromBase64(e2eKeyB64);
        const decryptedBuf = await decryptFileAuto(encryptedBuf, cryptoKey, 5_000_000);
        finalBlob = new Blob([decryptedBuf], { type: "application/pdf" });
      }

      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(doc as any)?.fileName || "document"}_signe.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("signing.toast.download-error"));
    }
  };

  if (isLoading) {
    return (
      <Container size="md" mt="xl" px={0}>
        <Box ta="center" py="xl"><Loader /></Box>
      </Container>
    );
  }

  if (!doc) {
    return (
      <Container size="md" mt="xl" px={0}>
        <Alert color="red">{t("signing.detail.not-found")}</Alert>
      </Container>
    );
  }

  const isPending = typedDoc.status === "PENDING" || typedDoc.status === "PARTIAL";
  const isAwaitingFinalization = typedDoc.status === "AWAITING_FINALIZATION";
  const fileDeleted = !!(typedDoc as any).fileDeleted;

  return (
    <>
      <Meta title={`${t("signing.title")} - ${typedDoc.fileName || typedDoc.title || t("signing.document")}`} />
      <Container size="md" mt="xl" px={0}>
        <Button variant="subtle" mb="md" onClick={() => router.push("/signing")}>
          {t("signing.detail.back")}
        </Button>

        <Group justify="space-between" mb="lg" align="flex-start">
          <div>
            <Title order={2}>
              <Group gap="xs">
                <TbFileDescription size={24} />
                {typedDoc.fileName || typedDoc.title || t("signing.document")}
              </Group>
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              {t("signing.detail.created-at", { date: formatDateTime(typedDoc.createdAt) })}
            </Text>
          </div>
          <Badge color={statusColors[typedDoc.status] || "gray"} size="lg" variant="light">
            {getStatusLabel(typedDoc.status)}
          </Badge>
        </Group>

        {typedDoc.message && (
          <Alert color="blue" mb="md" icon={<TbMail size={16} />}>
            <Text size="sm">{typedDoc.message}</Text>
          </Alert>
        )}

        {fileDeleted && (
          <Alert color="orange" mb="md" icon={<TbFileOff size={16} />}>
            {t("signing.detail.file-deleted-warning")}
          </Alert>
        )}

        {/* Actions */}
        <Group mb="lg" gap="sm">
          {typedDoc.status === "COMPLETED" && !fileDeleted && (
            <Button
              leftSection={<TbDownload size={16} />}
              onClick={handleDownload}
              disabled={typedDoc.isE2EEncrypted && !e2eKeyB64}
              title={typedDoc.isE2EEncrypted && !e2eKeyB64 ? t("signing.detail.finalize.e2e-unavailable") : undefined}
            >
              {t("signing.actions.download")}
            </Button>
          )}
          {isAwaitingFinalization && !fileDeleted && finalizing && (
            <Alert color="blue" icon={<Loader size={16} />}>
              {t("signing.detail.finalize.progress")}
            </Alert>
          )}
          {isAwaitingFinalization && !fileDeleted && !finalizing && !e2eKeyB64 && typedDoc.isE2EEncrypted && (
            <Alert color="yellow" icon={<TbLock size={16} />}>
              {t("signing.detail.finalize.key-resolving")}
            </Alert>
          )}
          {isAwaitingFinalization && !fileDeleted && !finalizing && typedDoc.isE2EEncrypted && e2eKeyB64 && autoFinalizeTriggered && (
            <Button
              color="orange"
              leftSection={<TbLock size={16} />}
              onClick={() => {
                setAutoFinalizeTriggered(false);
              }}
            >
              {t("signing.detail.finalize.retry")}
            </Button>
          )}
          {isAwaitingFinalization && !fileDeleted && !finalizing && !typedDoc.isE2EEncrypted && (
            <Button
              color="orange"
              leftSection={<TbShieldCheck size={16} />}
              onClick={async () => {
                setFinalizing(true);
                try {
                  const result = await signingService.retryFinalize(docId);
                  if (result.status === "COMPLETED") {
                    toast.success(t("signing.toast.finalize-success"));
                  } else {
                    toast.error(t("signing.toast.finalize-error"));
                  }
                  queryClient.invalidateQueries({ queryKey: ["signing.document", docId] });
                } catch {
                  toast.error(t("signing.toast.finalize-error"));
                } finally {
                  setFinalizing(false);
                }
              }}
            >
              {t("signing.detail.finalize.retry")}
            </Button>
          )}
          {isPending && (
            <>
              <Button
                variant="light"
                leftSection={<TbBell size={16} />}
                onClick={() => reminderMutation.mutate()}
                loading={reminderMutation.isPending}
              >
                {t("signing.actions.remind")}
              </Button>
              <Button
                variant="light"
                color="red"
                leftSection={<TbX size={16} />}
                onClick={() => cancelMutation.mutate()}
                loading={cancelMutation.isPending}
              >
                {t("signing.detail.cancel-request")}
              </Button>
            </>
          )}
        </Group>

        {/* Signing links */}
        {(isPending || isAwaitingFinalization) && typedDoc.recipients?.some((r: any) => r.signingToken && r.role !== "CC") && (
          <Paper withBorder p="md" mb="lg">
            <Text fw={600} mb="sm">
              <Group gap="xs"><TbLink size={16} /> {t("signing.detail.signing-links")}</Group>
            </Text>
            <Text size="xs" c="dimmed" mb="md">
              {t("signing.detail.signing-links.desc")}
            </Text>
            <Stack gap="xs">
              {typedDoc.recipients
                .filter((r: any) => r.signingToken && r.role !== "CC")
                .map((r: any) => {
                  const keyFragment = typedDoc.isE2EEncrypted && e2eKeyB64 ? `#key=${e2eKeyB64}` : "";
                  const signingUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/sign/${r.signingToken}${keyFragment}`;
                  return (
                    <Group key={r.id} gap="xs" wrap="nowrap">
                      <div style={{ minWidth: 140 }}>
                        <Text size="sm" fw={500} lineClamp={1}>{r.name}</Text>
                        <Text size="xs" c="dimmed">{r.email}</Text>
                      </div>
                      <Badge
                        color={statusColors[r.status] || "gray"}
                        variant="light"
                        size="sm"
                        style={{ flexShrink: 0 }}
                      >
                        {getStatusLabel(r.status)}
                      </Badge>
                      <TextInput
                        readOnly
                        size="sm"
                        value={signingUrl}
                        style={{ flex: 1 }}
                        rightSectionPointerEvents="all"
                        rightSection={
                          <CopyButton value={signingUrl}>
                            {({ copied, copy }) => (
                              <ActionIcon color={copied ? "green" : "blue"} variant="subtle" onClick={copy} size="md">
                                {copied ? <TbCheck size={16} /> : <TbCopy size={16} />}
                              </ActionIcon>
                            )}
                          </CopyButton>
                        }
                      />
                    </Group>
                  );
                })}
            </Stack>
          </Paper>
        )}

        {/* Recipients table */}
        <Paper withBorder mb="lg">
          <Text fw={600} p="md" pb={0}>{t("signing.detail.recipients")}</Text>
          {isMobile ? (
            <Stack gap="sm" p="md">
              {typedDoc.recipients?.map((r: any) => (
                <Card key={r.id} withBorder padding="sm">
                  <Group justify="space-between" mb={4}>
                    <Text fw={500} size="sm">{r.name}</Text>
                    <Badge
                      color={r.role === "SIGNER" ? "blue" : r.role === "APPROVER" ? "grape" : "gray"}
                      variant="light"
                      size="sm"
                    >
                      {getRoleLabel(r.role)}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed" mb={4}>{r.email}</Text>
                  <Group justify="space-between">
                    <Badge color={statusColors[r.status] || "gray"} variant="dot" size="sm">
                      {getStatusLabel(r.status)}
                    </Badge>
                    {r.signedAt ? (
                      <Text size="xs" c="dimmed">
                        {formatDateShort(r.signedAt)}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">-</Text>
                    )}
                  </Group>
                </Card>
              ))}
            </Stack>
          ) : (
          <Table striped highlightOnHover style={{ tableLayout: "fixed" }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 140 }}>{t("signing.detail.table.name")}</Table.Th>
                <Table.Th>{t("signing.detail.table.email")}</Table.Th>
                <Table.Th style={{ width: 110 }}>{t("signing.detail.table.role")}</Table.Th>
                <Table.Th style={{ width: 165 }}>{t("signing.detail.table.status")}</Table.Th>
                <Table.Th style={{ width: 155 }}>{t("signing.detail.table.signed-at")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {typedDoc.recipients?.map((r: any) => (
                <Table.Tr key={r.id}>
                  <Table.Td style={{ overflow: "hidden" }}><Text fw={500} size="sm" truncate>{r.name}</Text></Table.Td>
                  <Table.Td style={{ overflow: "hidden" }}><Text size="sm" c="dimmed" truncate>{r.email}</Text></Table.Td>
                  <Table.Td>
                    <Badge
                      color={r.role === "SIGNER" ? "blue" : r.role === "APPROVER" ? "grape" : "gray"}
                      variant="light"
                      size="sm"
                    >
                      {getRoleLabel(r.role)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={statusColors[r.status] || "gray"} variant="dot" size="sm">
                      {getStatusLabel(r.status)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {r.signedAt ? (
                      <Text size="sm">
                        {formatDateShort(r.signedAt)}
                      </Text>
                    ) : (
                      <Text size="sm" c="dimmed">-</Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          )}
        </Paper>

        {/* Audit trail */}
        {typedDoc.auditTrail?.length > 0 && (
          <Paper withBorder p="md">
            <Text fw={600} mb="md">
              <Group gap="xs"><TbShieldCheck size={16} /> {t("signing.detail.audit-trail")}</Group>
            </Text>
            <Timeline active={typedDoc.auditTrail.length - 1} bulletSize={20}>
              {typedDoc.auditTrail.map((event: any) => {
                const actionKeyMap: Record<string, string> = {
                  CREATED: "signing.detail.audit.created",
                  VIEWED: "signing.detail.audit.viewed",
                  SIGNED: "signing.detail.audit.signed",
                  REJECTED: "signing.detail.audit.rejected",
                  COMPLETED: "signing.detail.audit.completed",
                  AWAITING_FINALIZATION: "signing.detail.audit.awaiting-finalization",
                  CANCELLED: "signing.detail.audit.cancelled",
                  REMINDER_SENT: "signing.detail.audit.reminder-sent",
                  FINALIZED: "signing.detail.audit.finalized",
                  DOWNLOADED: "signing.detail.audit.downloaded",
                };
                const actionKey = actionKeyMap[event.action];
                const actionLabel = actionKey
                  ? t(actionKey, { email: event.actorEmail || "" })
                  : event.action;

                return (
                  <Timeline.Item
                    key={event.id}
                    title={<Text size="sm" fw={500}>{actionLabel}</Text>}
                  >
                    <Stack gap={2}>
                      <Text size="xs" c="dimmed">
                        {formatDateTime(event.createdAt)}
                      </Text>
                      {event.actorEmail && (
                        <Text size="xs" c="dimmed">
                          {t("signing.detail.audit.actor", { email: event.actorEmail })}
                        </Text>
                      )}
                      {(event.ip || event.ipAddress) && (
                        <Text size="xs" c="dimmed">
                          {t("signing.detail.audit.ip", { ip: event.ip || event.ipAddress })}
                        </Text>
                      )}
                      {event.details && (
                        <Text size="xs" mt={2}>{event.details}</Text>
                      )}
                      {event.reason && (
                        <Text size="xs" c="red" mt={2}>
                          {t("signing.detail.audit.reason", { reason: event.reason })}
                        </Text>
                      )}
                    </Stack>
                  </Timeline.Item>
                );
              })}
            </Timeline>
          </Paper>
        )}
      </Container>
    </>
  );
};

export default SigningDetailPage;
