import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useState, useEffect } from "react";
import "@mantine/core/styles/Timeline.css";
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
  TbArrowLeft,
  TbLink,
  TbLock,
  TbMail,
  TbQrcode,
  TbShieldCheck,
  TbX,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import { useModals } from "@mantine/modals";
import Meta from "../../components/Meta";
import signingService from "../../services/signing.service";
import shareService from "../../services/share.service";
import teamService from "../../services/team.service";
import {
  embedPadesCms,
  preparePadesPdf,
  sha256Hex,
} from "../../services/pades-client.service";
import showQrCodeModal from "../../components/core/showQrCodeModal";
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
import {
  getInitialsStampGeometry,
  shouldAddInitialsToPage,
} from "../../utils/pdfPlacement.util";

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
  const modals = useModals();
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
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    });

  const formatDateShort = (date: string) =>
    new Date(date).toLocaleDateString(intl.locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
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
  // Path 1: team folder -> unwrap team key
  // Path 2: non-team share -> resolve via share's e2e-key endpoint (K_master or unwrap reverse share key)
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
          // Path 1: Team folder -> derive from team key
          const { wrappedTeamKey } = await teamService.getTeamKey(
            typedDoc.teamId,
          );
          if (!wrappedTeamKey) return;
          const teamKey = await unwrapReverseShareKey(
            wrappedTeamKey,
            masterKey,
          );
          const keyB64 = await exportKeyToBase64(teamKey);
          setE2eKeyB64(keyB64);
        } else if (typedDoc.shareId) {
          // Path 2: Non-team share -> use master key or unwrap reverse share key
          const encryptedKey = await shareService.getEncryptedE2eKey(
            typedDoc.shareId,
          );
          if (encryptedKey) {
            // Reverse share: unwrap the share key with master key
            const shareKey = await unwrapReverseShareKey(
              encryptedKey,
              masterKey,
            );
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
  }, [
    typedDoc?.isE2EEncrypted,
    typedDoc?.teamId,
    typedDoc?.shareId,
    e2eKeyB64,
  ]);

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
  //   3. Append the certificate page and prepare the PAdES ByteRange client-side
  //   4. Send only the SHA-256 digest and embed the returned CMS client-side
  //   5. Re-encrypt before uploading the final PDF
  const handleFinalizeE2E = async () => {
    if (!e2eKeyB64 || !docId) return;
    setFinalizing(true);
    try {
      // 1. Download original encrypted PDF
      const encryptedBuf = await signingService.downloadOriginal(docId);

      // 2. Decrypt
      const cryptoKey = await importKeyFromBase64(e2eKeyB64);
      const decryptedBuf = await decryptFileAuto(
        encryptedBuf,
        cryptoKey,
        5_000_000,
      );

      // 3. Get signatures data from backend
      const sigData = await signingService.getSignaturesForFinalization(docId);

      // 4. Apply visual signatures with pdf-lib
      const { PDFDocument, rgb, StandardFonts, degrees } =
        await import("pdf-lib");
      const pdfDoc = await PDFDocument.load(decryptedBuf);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const textFields = (sigData.fields || []).filter(
        (field: any) =>
          !["SIGNATURE", "INITIALS"].includes(field.type) &&
          field.fieldValues?.length,
      );
      const signatureFields = (sigData.fields || []).filter(
        (field: any) => field.type === "SIGNATURE",
      );

      // Resolve target pages (1-based from backend, default page 1)
      const sigPageIdx = (sigData.signaturePage ?? 1) - 1;
      const wmPageIdx = sigData.addApprovalField
        ? (sigData.watermarkPage ?? sigData.signaturePage ?? 1) - 1
        : sigPageIdx;
      const maxFieldPageIdx = [...textFields, ...signatureFields].reduce(
        (max: number, field: any) => Math.max(max, (field.page ?? 1) - 1),
        -1,
      );

      // Add blank pages if needed
      const maxPageIdx = Math.max(sigPageIdx, wmPageIdx, maxFieldPageIdx);
      const pagesToAdd = maxPageIdx + 1 - pdfDoc.getPageCount();
      if (pagesToAdd > 0) {
        const [w, h] =
          pdfDoc.getPageCount() > 0
            ? [
                pdfDoc.getPage(0).getSize().width,
                pdfDoc.getPage(0).getSize().height,
              ]
            : [595, 842];
        for (let i = 0; i < pagesToAdd; i++) {
          pdfDoc.addPage([w, h]);
        }
      }
      const allPages = pdfDoc.getPages();
      const sigPage = allPages[sigPageIdx];
      const wmPage = sigData.addApprovalField ? allPages[wmPageIdx] : undefined;

      // Add "Bon pour Accord" diagonal watermark on target page if enabled
      if (sigData.addApprovalField && wmPage) {
        const { width: wmWidth, height: wmHeight } = wmPage.getSize();
        wmPage.drawText("Bon pour Accord", {
          x: wmWidth * 0.12,
          y: wmHeight * 0.38,
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
              .join(""),
          )
          .join(" / ");
        for (const [pageIndex, page] of allPages.entries()) {
          if (
            !shouldAddInitialsToPage({
              pageIndex,
              signaturePage: sigData.signaturePage,
              includeSignaturePage: sigData.initialsIncludeSignaturePage,
            })
          ) {
            continue;
          }
          const { width: pw, height: ph } = page.getSize();
          const geometry = getInitialsStampGeometry({
            pageWidth: pw,
            pageHeight: ph,
            textWidth: fontBold.widthOfTextAtSize(initialsText, 9),
            fontSize: 9,
            placement: sigData.initialsPlacement,
          });
          page.drawRectangle({
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            color: rgb(1, 1, 1),
            opacity: 0.94,
            borderColor: rgb(0.35, 0.35, 0.35),
            borderWidth: 0.6,
            borderOpacity: 0.75,
          });
          page.drawText(initialsText, {
            x: geometry.x + geometry.textXOffset,
            y: geometry.y + geometry.textYOffset,
            size: geometry.fontSize,
            font: fontBold,
            color: rgb(0.12, 0.12, 0.12),
          });
        }
      }

      const wrapPdfText = (
        text: string,
        maxWidth: number,
        fontSize: number,
      ) => {
        const words = text.replace(/\s+/g, " ").trim().split(" ");
        const lines: string[] = [];
        let current = "";
        for (const word of words) {
          const candidate = current ? `${current} ${word}` : word;
          if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
            current = candidate;
            continue;
          }
          if (current) lines.push(current);
          current = word;
        }
        if (current) lines.push(current);
        return lines.length > 0 ? lines : [text.trim()];
      };
      const placeContentWithinBox = (args: {
        boxX: number;
        boxY: number;
        boxWidth: number;
        boxHeight: number;
        contentWidth: number;
        contentHeight: number;
        pageWidth: number;
        pageHeight: number;
      }) => {
        const horizontalCenter = args.boxX + args.boxWidth / 2;
        const verticalCenter = args.boxY + args.boxHeight / 2;
        const rawX =
          horizontalCenter > args.pageWidth * 0.62
            ? args.boxX + args.boxWidth - args.contentWidth
            : horizontalCenter < args.pageWidth * 0.38
              ? args.boxX
              : args.boxX + (args.boxWidth - args.contentWidth) / 2;
        const rawY =
          verticalCenter > args.pageHeight * 0.62
            ? args.boxY + args.boxHeight - args.contentHeight
            : verticalCenter < args.pageHeight * 0.38
              ? args.boxY
              : args.boxY + (args.boxHeight - args.contentHeight) / 2;

        return {
          x: Math.min(Math.max(rawX, 0), args.pageWidth - args.contentWidth),
          y: Math.min(Math.max(rawY, 0), args.pageHeight - args.contentHeight),
        };
      };

      // Draw filled text/approval/date fields before signatures.
      for (const field of textFields) {
        const page = allPages[Math.max(0, (field.page ?? 1) - 1)];
        if (!page) continue;
        const { width: pageWidth, height: pageHeight } = page.getSize();
        const boxWidth = Math.min(Math.max(field.width || 200, 80), pageWidth);
        const boxHeight = Math.min(
          Math.max(field.height || 42, 24),
          pageHeight,
        );
        const x = Math.min(Math.max(field.posX || 0, 0), pageWidth - boxWidth);
        const y = Math.min(
          Math.max(field.posY || 0, 0),
          pageHeight - boxHeight,
        );
        const title =
          field.type === "APPROVAL"
            ? "Mention manuscrite"
            : field.type === "DATE"
              ? "Date"
              : field.label || "Texte";

        for (const fieldValue of field.fieldValues || []) {
          const paddingX = 6;
          const paddingY = 6;
          const titleSize = 7;
          const valueSize = field.type === "APPROVAL" ? 9 : 8;
          const lineHeight = valueSize + 3;
          const lines = wrapPdfText(
            String(fieldValue.value || ""),
            Math.max(20, boxWidth - paddingX * 2),
            valueSize,
          );
          const visibleLines = lines.slice(
            0,
            Math.max(
              1,
              Math.floor((boxHeight - paddingY * 2 - 14) / lineHeight),
            ),
          );
          const textWidth = Math.max(
            fontBold.widthOfTextAtSize(title, titleSize),
            ...visibleLines.map((line) =>
              font.widthOfTextAtSize(line, valueSize),
            ),
            40,
          );
          const contentWidth = Math.min(boxWidth, textWidth + paddingX * 2);
          const contentHeight = Math.min(
            boxHeight,
            Math.max(
              24,
              paddingY * 2 + 10 + 4 + visibleLines.length * lineHeight,
            ),
          );
          const contentPosition = placeContentWithinBox({
            boxX: x,
            boxY: y,
            boxWidth,
            boxHeight,
            contentWidth,
            contentHeight,
            pageWidth,
            pageHeight,
          });

          page.drawRectangle({
            x: contentPosition.x,
            y: contentPosition.y,
            width: contentWidth,
            height: contentHeight,
            color: rgb(1, 1, 1),
            opacity: 0.94,
            borderColor: rgb(0.55, 0.55, 0.55),
            borderWidth: 0.6,
          });
          page.drawText(title, {
            x: contentPosition.x + paddingX,
            y: contentPosition.y + contentHeight - paddingY - 7,
            size: titleSize,
            font: fontBold,
            color: rgb(0.32, 0.32, 0.32),
          });
          let textY = contentPosition.y + contentHeight - paddingY - 21;
          for (const line of visibleLines) {
            page.drawText(line, {
              x: contentPosition.x + paddingX,
              y: textY,
              size: valueSize,
              font,
              color: rgb(0.05, 0.05, 0.05),
            });
            textY -= lineHeight;
          }
        }
      }

      let yOffset = 120;
      for (const sig of sigData.signers || []) {
        if (!sig.signatureData) continue;

        const signatureField =
          signatureFields.find(
            (field: any) => field.assignedRecipientId === sig.id,
          ) || signatureFields.find((field: any) => !field.assignedRecipientId);
        const targetPage = signatureField
          ? allPages[Math.max(0, (signatureField.page ?? 1) - 1)]
          : sigPage;
        const { width: sigW, height: sigH } = targetPage.getSize();
        const boxWidth = signatureField
          ? Math.min(Math.max(signatureField.width || 240, 120), sigW)
          : 240;
        const boxHeight = signatureField
          ? Math.min(
              Math.max(signatureField.height || (addMention ? 90 : 70), 50),
              sigH,
            )
          : addMention
            ? 90
            : 70;
        const boxX = signatureField
          ? Math.min(Math.max(signatureField.posX || 0, 0), sigW - boxWidth)
          : sigW - 250;
        const boxY = signatureField
          ? Math.min(Math.max(signatureField.posY || 0, 0), sigH - boxHeight)
          : yOffset;
        const paddingX = 8;
        const paddingY = 8;
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
        const maxSignatureWidth = Math.max(20, boxWidth - paddingX * 2);
        const imageWidth = Math.min(sigDims.width, maxSignatureWidth, 180);
        const imageHeight = Math.min(
          sigDims.height,
          Math.max(28, boxHeight - (addMention ? 42 : 26)),
          40,
        );
        const dateStr = new Date(sig.signedAt).toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Europe/Paris",
        });
        const approvalText = `Lu et approuvé le ${dateStr}`;
        const approvalWidth = addMention
          ? Math.min(font.widthOfTextAtSize(approvalText, 9), maxSignatureWidth)
          : 0;
        const nameWidth = Math.min(
          fontBold.widthOfTextAtSize(sig.name, 10),
          maxSignatureWidth,
        );
        const contentWidth = Math.min(
          boxWidth,
          Math.max(80, approvalWidth, nameWidth, imageWidth) + paddingX * 2,
        );
        const contentHeight = Math.min(
          boxHeight,
          Math.max(
            44,
            paddingY * 2 + (addMention ? 13 : 0) + 14 + 6 + imageHeight,
          ),
        );
        const contentPosition = placeContentWithinBox({
          boxX,
          boxY,
          boxWidth,
          boxHeight,
          contentWidth,
          contentHeight,
          pageWidth: sigW,
          pageHeight: sigH,
        });
        const innerX = contentPosition.x + paddingX;
        const imageY = contentPosition.y + paddingY;

        targetPage.drawRectangle({
          x: contentPosition.x,
          y: contentPosition.y,
          width: contentWidth,
          height: contentHeight,
          color: rgb(1, 1, 1),
          opacity: 1,
          borderColor: rgb(0.7, 0.7, 0.7),
          borderWidth: 0.8,
        });

        if (addMention) {
          targetPage.drawText(approvalText, {
            x: innerX,
            y: contentPosition.y + contentHeight - paddingY - 9,
            size: 9,
            font,
            color: rgb(0, 0, 0),
          });
        }
        targetPage.drawText(sig.name, {
          x: innerX,
          y:
            contentPosition.y +
            contentHeight -
            paddingY -
            (addMention ? 26 : 12),
          size: 10,
          font: fontBold,
          color: rgb(0, 0, 0),
        });

        targetPage.drawImage(sigImage, {
          x: innerX,
          y: imageY,
          width: imageWidth,
          height: imageHeight,
        });

        if (!signatureField) yOffset += 80;
      }

      // 5. Save PDF with visual signatures
      const visuallySignedPdf = await pdfDoc.save();

      // 6. Ask the backend for the standalone certificate page using only a hash
      const visualPdfHash = await sha256Hex(visuallySignedPdf);
      const certificatePage = await signingService.getE2ECertificatePage(
        docId,
        visualPdfHash,
      );

      // 7. Prepare ByteRange locally, sign only its digest, then embed the CMS locally
      const preparedPdf = await preparePadesPdf(
        visuallySignedPdf,
        certificatePage,
      );
      const cms = await signingService.signE2EDigest(docId, preparedPdf.digest);
      const padesSignedPdf = embedPadesCms(preparedPdf.bytes, cms);

      // 8. Re-encrypt the PAdES-signed PDF before any file upload
      const padesSignedBuffer = padesSignedPdf.buffer.slice(
        padesSignedPdf.byteOffset,
        padesSignedPdf.byteOffset + padesSignedPdf.byteLength,
      ) as ArrayBuffer;
      const reEncrypted = await encryptFile(padesSignedBuffer, cryptoKey);

      // 9. Upload encrypted final PDF for storage
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
        const decryptedBuf = await decryptFileAuto(
          encryptedBuf,
          cryptoKey,
          5_000_000,
        );
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
      <Container size="md" px={0}>
        <Box ta="center" py="xl">
          <Loader />
        </Box>
      </Container>
    );
  }

  if (!doc) {
    return (
      <Container size="md" px={0}>
        <Alert color="red">{t("signing.detail.not-found")}</Alert>
      </Container>
    );
  }

  const isPending =
    typedDoc.status === "PENDING" || typedDoc.status === "PARTIAL";
  const isAwaitingFinalization = typedDoc.status === "AWAITING_FINALIZATION";
  const fileDeleted = !!(typedDoc as any).fileDeleted;

  return (
    <>
      <Meta
        title={`${t("signing.title")} - ${typedDoc.fileName || typedDoc.title || t("signing.document")}`}
      />
      <Container size="md" px={0}>
        <Button
          variant="subtle"
          mb="md"
          leftSection={<TbArrowLeft size={16} />}
          onClick={() => router.push("/signing")}
        >
          {t("signing.detail.back")}
        </Button>

        <Group
          justify="space-between"
          mb="lg"
          align="flex-start"
          wrap={isMobile ? "wrap" : "nowrap"}
        >
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Title order={2}>
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <TbFileDescription
                  size={24}
                  style={{ flexShrink: 0, marginTop: 4 }}
                />
                <Text
                  span
                  inherit
                  style={{
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    hyphens: "auto",
                    lineHeight: 1.2,
                  }}
                >
                  {typedDoc.fileName || typedDoc.title || t("signing.document")}
                </Text>
              </Group>
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              {t("signing.detail.created-at", {
                date: formatDateTime(typedDoc.createdAt),
              })}
            </Text>
          </Box>
          <Badge
            color={statusColors[typedDoc.status] || "gray"}
            size="lg"
            variant="light"
            style={{ flexShrink: 0 }}
          >
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
              title={
                typedDoc.isE2EEncrypted && !e2eKeyB64
                  ? t("signing.detail.finalize.e2e-unavailable")
                  : undefined
              }
            >
              {t("signing.actions.download")}
            </Button>
          )}
          {isAwaitingFinalization && !fileDeleted && finalizing && (
            <Alert color="blue" icon={<Loader size={16} />}>
              {t("signing.detail.finalize.progress")}
            </Alert>
          )}
          {isAwaitingFinalization &&
            !fileDeleted &&
            !finalizing &&
            !e2eKeyB64 &&
            typedDoc.isE2EEncrypted && (
              <Alert color="yellow" icon={<TbLock size={16} />}>
                {t("signing.detail.finalize.key-resolving")}
              </Alert>
            )}
          {isAwaitingFinalization &&
            !fileDeleted &&
            !finalizing &&
            typedDoc.isE2EEncrypted &&
            e2eKeyB64 &&
            autoFinalizeTriggered && (
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
          {isAwaitingFinalization &&
            !fileDeleted &&
            !finalizing &&
            !typedDoc.isE2EEncrypted && (
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
                    queryClient.invalidateQueries({
                      queryKey: ["signing.document", docId],
                    });
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
          {isPending && !fileDeleted && (
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

        {/* Signing links - always shown to the document creator so they can re-send them */}
        {!fileDeleted &&
          typedDoc.recipients?.some(
            (r: any) => r.signingToken && r.role !== "CC",
          ) && (
            <Paper withBorder p="md" mb="lg">
              <Text fw={600} mb="sm">
                <Group gap="xs">
                  <TbLink size={16} /> {t("signing.detail.signing-links")}
                </Group>
              </Text>
              <Text size="xs" c="dimmed" mb="md">
                {typedDoc.status === "COMPLETED"
                  ? t("signing.detail.signing-links.completed-desc")
                  : t("signing.detail.signing-links.desc")}
              </Text>
              <Stack gap="xs">
                {typedDoc.recipients
                  .filter((r: any) => r.signingToken && r.role !== "CC")
                  .map((r: any) => {
                    const keyFragment =
                      typedDoc.isE2EEncrypted && e2eKeyB64
                        ? `#key=${e2eKeyB64}`
                        : "";
                    const signingUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/sign/${r.signingToken}${keyFragment}`;
                    return (
                      <Group
                        key={r.id}
                        gap="xs"
                        align="flex-start"
                        wrap={isMobile ? "wrap" : "nowrap"}
                      >
                        <Box
                          style={{
                            minWidth: 0,
                            flex: isMobile ? "1 1 100%" : "0 0 140px",
                          }}
                        >
                          <Text
                            size="sm"
                            fw={500}
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {r.name}
                          </Text>
                          <Text
                            size="xs"
                            c="dimmed"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {r.email}
                          </Text>
                        </Box>
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
                          style={{
                            flex: "1 1 240px",
                            minWidth: isMobile ? "100%" : 0,
                          }}
                          rightSectionPointerEvents="all"
                          rightSectionWidth={68}
                          rightSection={
                            <Group gap={2} wrap="nowrap">
                              <CopyButton value={signingUrl}>
                                {({ copied, copy }) => (
                                  <ActionIcon
                                    color={copied ? "green" : "blue"}
                                    variant="subtle"
                                    onClick={copy}
                                    size="md"
                                  >
                                    {copied ? (
                                      <TbCheck size={16} />
                                    ) : (
                                      <TbCopy size={16} />
                                    )}
                                  </ActionIcon>
                                )}
                              </CopyButton>
                              <ActionIcon
                                color="grape"
                                variant="subtle"
                                size="md"
                                onClick={() =>
                                  showQrCodeModal(modals, signingUrl)
                                }
                                title={t("common.button.showQrCode")}
                              >
                                <TbQrcode size={16} />
                              </ActionIcon>
                            </Group>
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
          <Text fw={600} p="md" pb={0}>
            {t("signing.detail.recipients")}
          </Text>
          {isMobile ? (
            <Stack gap="sm" p="md">
              {typedDoc.recipients?.map((r: any) => (
                <Card key={r.id} withBorder padding="sm">
                  <Group
                    justify="space-between"
                    mb={4}
                    align="flex-start"
                    wrap="nowrap"
                  >
                    <Text
                      fw={500}
                      size="sm"
                      style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}
                    >
                      {r.name}
                    </Text>
                    <Badge
                      color={
                        r.role === "SIGNER"
                          ? "blue"
                          : r.role === "APPROVER"
                            ? "grape"
                            : "gray"
                      }
                      variant="light"
                      size="sm"
                      style={{ flexShrink: 0 }}
                    >
                      {getRoleLabel(r.role)}
                    </Badge>
                  </Group>
                  <Text
                    size="xs"
                    c="dimmed"
                    mb={4}
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {r.email}
                  </Text>
                  <Group justify="space-between">
                    <Badge
                      color={statusColors[r.status] || "gray"}
                      variant="dot"
                      size="sm"
                    >
                      {getStatusLabel(r.status)}
                    </Badge>
                    {r.signedAt ? (
                      <Text size="xs" c="dimmed">
                        {formatDateShort(r.signedAt)}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        -
                      </Text>
                    )}
                  </Group>
                </Card>
              ))}
            </Stack>
          ) : (
            <Table striped highlightOnHover style={{ tableLayout: "fixed" }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ width: 140 }}>
                    {t("signing.detail.table.name")}
                  </Table.Th>
                  <Table.Th>{t("signing.detail.table.email")}</Table.Th>
                  <Table.Th style={{ width: 110 }}>
                    {t("signing.detail.table.role")}
                  </Table.Th>
                  <Table.Th style={{ width: 165 }}>
                    {t("signing.detail.table.status")}
                  </Table.Th>
                  <Table.Th style={{ width: 155 }}>
                    {t("signing.detail.table.signed-at")}
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {typedDoc.recipients?.map((r: any) => (
                  <Table.Tr key={r.id}>
                    <Table.Td style={{ overflow: "hidden" }}>
                      <Text fw={500} size="sm" truncate>
                        {r.name}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ overflow: "hidden" }}>
                      <Text size="sm" c="dimmed" truncate>
                        {r.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={
                          r.role === "SIGNER"
                            ? "blue"
                            : r.role === "APPROVER"
                              ? "grape"
                              : "gray"
                        }
                        variant="light"
                        size="sm"
                      >
                        {getRoleLabel(r.role)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={statusColors[r.status] || "gray"}
                        variant="dot"
                        size="sm"
                      >
                        {getStatusLabel(r.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {r.signedAt ? (
                        <Text size="sm">{formatDateShort(r.signedAt)}</Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          -
                        </Text>
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
              <Group gap="xs">
                <TbShieldCheck size={16} /> {t("signing.detail.audit-trail")}
              </Group>
            </Text>
            <Timeline active={typedDoc.auditTrail.length - 1} bulletSize={20}>
              {typedDoc.auditTrail.map((event: any) => {
                const actionKeyMap: Record<string, string> = {
                  CREATED: "signing.detail.audit.created",
                  VIEWED: "signing.detail.audit.viewed",
                  SIGNED: "signing.detail.audit.signed",
                  REJECTED: "signing.detail.audit.rejected",
                  COMPLETED: "signing.detail.audit.completed",
                  AWAITING_FINALIZATION:
                    "signing.detail.audit.awaiting-finalization",
                  CANCELLED: "signing.detail.audit.cancelled",
                  REMINDER_SENT: "signing.detail.audit.reminder-sent",
                  FINALIZED: "signing.detail.audit.finalized",
                  DOWNLOADED: "signing.detail.audit.downloaded",
                  SOURCE_FILE_DELETED:
                    "signing.detail.audit.source-file-deleted",
                };
                const actionKey = actionKeyMap[event.action];
                const actionLabel = actionKey
                  ? t(actionKey, { email: event.actorEmail || "" })
                  : event.action;

                return (
                  <Timeline.Item
                    key={event.id}
                    title={
                      <Text size="sm" fw={500}>
                        {actionLabel}
                      </Text>
                    }
                  >
                    <Stack gap={2}>
                      <Text size="xs" c="dimmed">
                        {formatDateTime(event.createdAt)}
                      </Text>
                      {event.actorEmail && (
                        <Text size="xs" c="dimmed">
                          {t("signing.detail.audit.actor", {
                            email: event.actorEmail,
                          })}
                        </Text>
                      )}
                      {(event.ip || event.ipAddress) && (
                        <Text size="xs" c="dimmed">
                          {t("signing.detail.audit.ip", {
                            ip: event.ip || event.ipAddress,
                          })}
                        </Text>
                      )}
                      {event.details && (
                        <Text size="xs" mt={2}>
                          {event.details}
                        </Text>
                      )}
                      {event.reason && (
                        <Text size="xs" c="red" mt={2}>
                          {t("signing.detail.audit.reason", {
                            reason: event.reason,
                          })}
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
