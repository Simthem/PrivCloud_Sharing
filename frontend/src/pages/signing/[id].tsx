import { openSigningKey } from "../../utils/signingKeyEnvelope.util";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useState, useEffect, useRef } from "react";
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
import SigningActionButton from "../../components/signing/SigningActionButton";
import signingService, {
  SignatureRecipient,
} from "../../services/signing.service";
import shareService from "../../services/share.service";
import teamService from "../../services/team.service";
import { resolveOwnerShareKey } from "../../utils/shareKey.util";
import {
  embedPadesCms,
  preparePadesPdf,
  sha256Hex,
} from "../../services/pades-client.service";
import showQrCodeModal from "../../components/core/showQrCodeModal";
import { reconcileSignerContributions } from "../../utils/signingReconciliation.util";
import { parseSignatureData } from "../../utils/signatureData.util";
import { pdfSafeText } from "../../utils/pdfText.util";
import {
  defaultSignatureSlotPosition,
  fitSignatureImage,
  resolveSignatureSlots,
} from "../../utils/signatureSlots.util";
import toast from "../../utils/toast.util";
import { saveBlobToDevice } from "../../utils/saveBlob.util";
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
  contentWriteScheme,
  encryptContentV2,
  isContentV2,
} from "../../utils/contentV2.util";
import { contentPolicy } from "../../utils/contentPolicy.util";
import {
  getInitialsStampGeometry,
  normalizedPdfRotation,
  pageSizePoints,
  rawPdfBoxToVisual,
  shouldAddInitialsToPage,
  visualPdfPointToRaw,
} from "../../utils/pdfPlacement.util";
import {
  signedPdfName,
  approvalMention,
  approvalWatermark,
  signingLanguage,
} from "../../utils/signingLanguage.util";
import useUserKeyGeneration from "../../hooks/useUserKeyGeneration.hook";

const statusColors: Record<string, string> = {
  PENDING: "yellow",
  VIEWED: "blue",
  SIGNED: "green",
  REJECTED: "red",
  PARTIAL: "blue",
  COMPLETED: "green",
  CANCELLED: "gray",
  AWAITING_FINALIZATION: "orange",
  SIGNING_FAILED: "red",
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
  SIGNING_FAILED: "signing.status.signing-failed",
};

const SigningDetailPage = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const modals = useModals();
  const { user } = useUser();
  const viewerId = user?.id;
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
  const [e2eKeyContext, setE2eKeyContext] = useState<{
    documentId: string;
    userId?: string;
    key: string;
  } | null>(null);
  const e2eKeyB64 =
    e2eKeyContext &&
    e2eKeyContext.documentId === docId &&
    e2eKeyContext.userId === user?.id
      ? e2eKeyContext.key
      : null;
  // Set once every resolution path has been tried, so a missing key is only
  // reported after the lookup, not while it is still running.
  const [e2eKeyLookupDone, setE2eKeyLookupDone] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [autoFinalizeTriggered, setAutoFinalizeTriggered] = useState(false);
  const [downloadingProof, setDownloadingProof] = useState<
    "signed" | "evidence" | "forensic" | null
  >(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["signing.document", docId, user?.id],
    queryFn: () => signingService.getDocument(docId),
    enabled: !!docId,
  });

  const keyGeneration = useUserKeyGeneration();
  // Resolve E2E key when document is E2E encrypted
  // Path 1: team folder -> unwrap team key
  // Path 2: non-team share -> resolve via share's e2e-key endpoint (K_master or unwrap reverse share key)
  useEffect(() => {
    if (!doc?.isE2EEncrypted) return;
    if (e2eKeyB64) return; // already resolved
    const ownWrappedKey: string | undefined = doc?.recipients?.find(
      (recipient: SignatureRecipient) =>
        recipient.isCurrentUser && recipient.wrappedE2EKey,
    )?.wrappedE2EKey;
    const ownEnvelope = doc.recipients.find(
      (recipient) => recipient.isCurrentUser,
    )?.encryptedKeyEnvelope;
    // Need at least one resolution path
    if (!ownWrappedKey && !ownEnvelope && !doc?.teamId && !doc?.shareId) {
      setE2eKeyLookupDone(true);
      return;
    }

    (async () => {
      try {
        const userKeyB64 = getUserKey();
        if (!userKeyB64) return;
        const masterKey = await importKeyFromBase64(userKeyB64);

        const retainedResult = doc.status === "COMPLETED" && doc.fileDeleted;
        if (ownEnvelope && viewerId && (doc.fileId || retainedResult)) {
          try {
            const key = await openSigningKey(
              ownEnvelope,
              {
                documentId: docId,
                fileId: doc.fileId ?? null,
                recipientUserId: viewerId,
              },
              masterKey,
            );
            setE2eKeyContext({ documentId: docId, userId: viewerId, key });
            return;
          } catch (error) {
            if (!ownWrappedKey && !doc.shareId) throw error;
          }
        }
        if (ownWrappedKey) {
          // Path 0: signer, key kept for this account when the link was opened
          const documentKey = await unwrapReverseShareKey(
            ownWrappedKey,
            masterKey,
          );
          setE2eKeyContext({
            documentId: docId,
            userId: viewerId,
            key: await exportKeyToBase64(documentKey),
          });
        } else if (doc.teamId) {
          // Path 1: Team folder -> derive from team key
          const { wrappedTeamKey } = await teamService.getTeamKey(doc.teamId);
          if (!wrappedTeamKey) return;
          const teamKey = await unwrapReverseShareKey(
            wrappedTeamKey,
            masterKey,
          );
          const keyB64 = await exportKeyToBase64(teamKey);
          setE2eKeyContext({
            documentId: docId,
            userId: viewerId,
            key: keyB64,
          });
        } else if (doc.shareId) {
          // Path 2: Non-team share -> unwrap the reverse-share key or the
          // SHARE_DEK_V1 share key, else the file uses the master key
          const material = await shareService.getShareKeyMaterial(doc.shareId);
          setE2eKeyContext({
            documentId: docId,
            userId: viewerId,
            key: await resolveOwnerShareKey(doc.shareId, userKeyB64, material),
          });
        }
      } catch {
        // Key resolution failed - user may not have access
      } finally {
        setE2eKeyLookupDone(true);
      }
    })();
  }, [
    docId,
    viewerId,
    doc?.fileId,
    doc?.status,
    doc?.fileDeleted,
    doc?.isE2EEncrypted,
    doc?.teamId,
    doc?.shareId,
    doc?.recipients,
    e2eKeyB64,
    keyGeneration,
  ]);

  const envelopeRepairAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (
      !doc?.isRequester ||
      !doc.isE2EEncrypted ||
      !doc.fileId ||
      !e2eKeyB64 ||
      !user ||
      !["PENDING", "PARTIAL"].includes(doc.status)
    )
      return;
    const missing = doc.recipients.filter(
      (recipient) =>
        recipient.role === "SIGNER" &&
        ["PENDING", "VIEWED"].includes(recipient.status) &&
        !recipient.hasKeyEnvelope,
    );
    if (!missing.length) return;
    const attempt = JSON.stringify([
      doc.id,
      user.id,
      e2eKeyB64,
      missing.map((recipient) => recipient.id),
    ]);
    if (envelopeRepairAttempt.current === attempt) return;
    envelopeRepairAttempt.current = attempt;
    let active = true;
    void signingService
      .ensureRecipientKeyEnvelopes(doc, e2eKeyB64)
      .then(({ stored }) => {
        if (active && stored)
          void queryClient.invalidateQueries({
            queryKey: ["signing.document", doc.id, user.id],
          });
      })
      .catch(() => {
        if (active) toast.error(t("signing.key.delivery-error"));
      });
    return () => {
      active = false;
    };
  }, [doc, e2eKeyB64, user, queryClient, t]);

  // Auto-finalize E2E documents when key is resolved and status is AWAITING_FINALIZATION
  useEffect(() => {
    if (
      doc?.isRequester &&
      doc?.status === "AWAITING_FINALIZATION" &&
      doc?.isE2EEncrypted &&
      !doc?.fileDeleted &&
      e2eKeyB64 &&
      !finalizing &&
      !autoFinalizeTriggered
    ) {
      setAutoFinalizeTriggered(true);
      handleFinalizeE2E();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    doc?.isRequester,
    doc?.status,
    e2eKeyB64,
    finalizing,
    autoFinalizeTriggered,
  ]);

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
        doc?.fileId ? { fileId: doc.fileId } : undefined,
      );

      // 3. Get signatures data from backend
      const sigData = await signingService.getSignaturesForFinalization(docId);
      const markLanguage = signingLanguage(sigData.language);

      // 3b. Rebuild every signer's contribution locally and refuse to seal
      // anything a signer did not approve with WebAuthn.
      const sourceSha256 = await sha256Hex(new Uint8Array(decryptedBuf));
      if (sigData.signatureLevel === "REINFORCED") {
        const problems = await reconcileSignerContributions({
          documentId: docId,
          sourceSha256,
          signers: sigData.signers,
          fieldValues: (sigData.fields || []).flatMap(
            (field) => field.fieldValues || [],
          ),
          sha256Hex,
        });
        if (problems.length > 0) {
          throw new Error(
            `Signer contributions do not match the signed manifests: ${problems.join(", ")}`,
          );
        }
      }

      // 4. Apply visual signatures with pdf-lib
      const { PDFDocument, rgb, StandardFonts, degrees } =
        await import("pdf-lib");
      const pdfDoc = await PDFDocument.load(decryptedBuf);
      // Keep the exact decrypted source approved by the signers inside the
      // sealed PDF so the WebAuthn manifest hash stays checkable offline.
      await pdfDoc.attach(
        new Uint8Array(decryptedBuf),
        "privcloud-source.pdf",
        {
          mimeType: "application/pdf",
          description: `Source document SHA-256 ${sourceSha256}`,
        },
      );
      for (const entry of Array.isArray(sigData.pageRotations)
        ? sigData.pageRotations
        : []) {
        const page = pdfDoc.getPages()[entry.page - 1];
        if (page && [90, 180, 270].includes(entry.rotation)) {
          page.setRotation(
            degrees(
              normalizedPdfRotation(page.getRotation().angle + entry.rotation),
            ),
          );
        }
      }
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const textFields = (sigData.fields || []).filter(
        (field) =>
          !["SIGNATURE", "INITIALS"].includes(field.type) &&
          field.fieldValues?.length,
      );
      const signatureFields = (sigData.fields || []).filter(
        (field) => field.type === "SIGNATURE",
      );

      // Resolve target pages (1-based from backend, default page 1)
      const sigPageIdx = (sigData.signaturePage ?? 1) - 1;
      const wmPageIdx = sigData.addApprovalField
        ? (sigData.watermarkPage ?? sigData.signaturePage ?? 1) - 1
        : sigPageIdx;
      const maxFieldPageIdx = [...textFields, ...signatureFields].reduce(
        (max: number, field) => Math.max(max, (field.page ?? 1) - 1),
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
      const getDrawLayout = (page: (typeof allPages)[number]) => ({
        widthPoints: page.getSize().width,
        heightPoints: page.getSize().height,
        rotation: page.getRotation().angle,
      });

      // Add "Bon pour Accord" diagonal watermark on target page if enabled
      if (sigData.addApprovalField && wmPage) {
        const wmLayout = getDrawLayout(wmPage);
        const wmVisualSize = pageSizePoints(wmLayout);
        const watermarkOrigin = visualPdfPointToRaw(
          {
            x: wmVisualSize.width * 0.12,
            y: wmVisualSize.height * 0.38,
          },
          wmLayout,
        );
        wmPage.drawText(approvalWatermark(markLanguage), {
          x: watermarkOrigin.x,
          y: watermarkOrigin.y,
          size: 60,
          font: fontBold,
          color: rgb(0.5, 0.75, 0.5),
          opacity: 0.35,
          rotate: degrees(normalizedPdfRotation(wmLayout.rotation) + 45),
        });
      }

      // Add "Lu et approuvé" mention if enabled
      const addMention = sigData.addApprovalMention !== false; // default true

      // Add initials at bottom of each page if enabled
      if (sigData.addInitials && sigData.signers?.length) {
        const initialsText = pdfSafeText(
          sigData.signers
            .map((s) =>
              s.name
                .split(" ")
                .map((w: string) => [...w][0]?.toUpperCase() || "")
                .join(""),
            )
            .join(" / "),
          fontBold,
        );
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
          const pageLayout = getDrawLayout(page);
          const { width: pw, height: ph } = pageSizePoints(pageLayout);
          const geometry = getInitialsStampGeometry({
            pageWidth: pw,
            pageHeight: ph,
            textWidth: fontBold.widthOfTextAtSize(initialsText, 9),
            fontSize: 9,
            placement: sigData.initialsPlacement,
          });
          const drawRotation = normalizedPdfRotation(pageLayout.rotation);
          const stampOrigin = visualPdfPointToRaw(geometry, pageLayout);
          page.drawRectangle({
            x: stampOrigin.x,
            y: stampOrigin.y,
            width: geometry.width,
            height: geometry.height,
            rotate: degrees(drawRotation),
            color: rgb(1, 1, 1),
            opacity: 0.94,
            borderColor: rgb(0.35, 0.35, 0.35),
            borderWidth: 0.6,
            borderOpacity: 0.75,
          });
          const textOrigin = visualPdfPointToRaw(
            {
              x: geometry.x + geometry.textXOffset,
              y: geometry.y + geometry.textYOffset,
            },
            pageLayout,
          );
          page.drawText(initialsText, {
            x: textOrigin.x,
            y: textOrigin.y,
            size: geometry.fontSize,
            font: fontBold,
            color: rgb(0.12, 0.12, 0.12),
            rotate: degrees(drawRotation),
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
        const pageLayout = getDrawLayout(page);
        const { width: pageWidth, height: pageHeight } =
          pageSizePoints(pageLayout);
        const visualField = rawPdfBoxToVisual(
          {
            x: field.posX,
            y: field.posY,
            width: field.width,
            height: field.height,
          },
          pageLayout,
        );
        const boxWidth = Math.min(
          Math.max(visualField.width || 200, 80),
          pageWidth,
        );
        const boxHeight = Math.min(
          Math.max(visualField.height || 42, 24),
          pageHeight,
        );
        const x = Math.min(
          Math.max(visualField.x || 0, 0),
          pageWidth - boxWidth,
        );
        const y = Math.min(
          Math.max(visualField.y || 0, 0),
          pageHeight - boxHeight,
        );
        const title =
          field.type === "APPROVAL"
            ? "Mention manuscrite"
            : field.type === "DATE"
              ? "Date"
              : pdfSafeText(field.label || "Texte", fontBold);

        for (const fieldValue of field.fieldValues || []) {
          const paddingX = 6;
          const paddingY = 6;
          const titleSize = 7;
          const valueSize = field.type === "APPROVAL" ? 9 : 8;
          const lineHeight = valueSize + 3;
          const lines = wrapPdfText(
            pdfSafeText(String(fieldValue.value || ""), font),
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
          const drawRotation = normalizedPdfRotation(pageLayout.rotation);
          const contentOrigin = visualPdfPointToRaw(
            contentPosition,
            pageLayout,
          );

          page.drawRectangle({
            x: contentOrigin.x,
            y: contentOrigin.y,
            width: contentWidth,
            height: contentHeight,
            rotate: degrees(drawRotation),
            color: rgb(1, 1, 1),
            opacity: 0.94,
            borderColor: rgb(0.55, 0.55, 0.55),
            borderWidth: 0.6,
          });
          const titleOrigin = visualPdfPointToRaw(
            {
              x: contentPosition.x + paddingX,
              y: contentPosition.y + contentHeight - paddingY - 7,
            },
            pageLayout,
          );
          page.drawText(title, {
            x: titleOrigin.x,
            y: titleOrigin.y,
            size: titleSize,
            font: fontBold,
            color: rgb(0.32, 0.32, 0.32),
            rotate: degrees(drawRotation),
          });
          let textY = contentPosition.y + contentHeight - paddingY - 21;
          for (const line of visibleLines) {
            const lineOrigin = visualPdfPointToRaw(
              { x: contentPosition.x + paddingX, y: textY },
              pageLayout,
            );
            page.drawText(line, {
              x: lineOrigin.x,
              y: lineOrigin.y,
              size: valueSize,
              font,
              color: rgb(0.05, 0.05, 0.05),
              rotate: degrees(drawRotation),
            });
            textY -= lineHeight;
          }
        }
      }

      // Every signer gets its own block, never the same position as another.
      const signatureSlots = resolveSignatureSlots(
        (sigData.signers || []).map((sig) => sig.id),
        sigData.fields || [],
      );
      for (const sig of sigData.signers || []) {
        if (!sig.signatureData) continue;

        const slot = signatureSlots.get(sig.id);
        const signatureField = slot?.kind === "field" ? slot.field : undefined;
        const targetPage = signatureField
          ? allPages[Math.max(0, (signatureField.page ?? 1) - 1)]
          : sigPage;
        const targetLayout = getDrawLayout(targetPage);
        const { width: sigW, height: sigH } = pageSizePoints(targetLayout);
        const visualField = signatureField
          ? rawPdfBoxToVisual(
              {
                x: signatureField.posX,
                y: signatureField.posY,
                width: signatureField.width,
                height: signatureField.height,
              },
              targetLayout,
            )
          : undefined;
        const boxWidth = signatureField
          ? Math.min(Math.max(visualField?.width || 240, 120), sigW)
          : 240;
        const boxHeight = signatureField
          ? Math.min(
              Math.max(visualField?.height || (addMention ? 90 : 70), 50),
              sigH,
            )
          : addMention
            ? 90
            : 70;
        const defaultPosition = defaultSignatureSlotPosition({
          index: slot?.kind === "default" ? slot.index : 0,
          count: slot?.kind === "default" ? slot.count : 1,
          pageWidth: sigW,
          boxWidth,
          boxHeight,
          rightEdge: sigW - 10,
          baseY: 120,
        });
        const boxX = signatureField
          ? Math.min(Math.max(visualField?.x || 0, 0), sigW - boxWidth)
          : defaultPosition.x;
        const boxY = signatureField
          ? Math.min(Math.max(visualField?.y || 0, 0), sigH - boxHeight)
          : defaultPosition.y;
        const paddingX = 8;
        const paddingY = 8;
        // Same parsing as the server: the format comes from the bytes, and a
        // typed signature sent as text is drawn as text.
        const signatureVisual = parseSignatureData(
          sig.signatureData,
          sig.signatureType,
        );
        const sigImage =
          signatureVisual.kind === "image"
            ? signatureVisual.format === "jpg"
              ? await pdfDoc.embedJpg(signatureVisual.bytes)
              : await pdfDoc.embedPng(signatureVisual.bytes)
            : null;
        const signatureText =
          signatureVisual.kind === "text"
            ? pdfSafeText(signatureVisual.text, font)
            : "";
        const signerName = pdfSafeText(sig.name, fontBold);
        const maxSignatureWidth = Math.max(20, boxWidth - paddingX * 2);
        const { width: imageWidth, height: imageHeight } = sigImage
          ? fitSignatureImage(sigImage.scale(0.5), {
              width: Math.min(maxSignatureWidth, 180),
              height: Math.min(
                Math.max(28, boxHeight - (addMention ? 42 : 26)),
                40,
              ),
            })
          : {
              width: Math.min(
                font.widthOfTextAtSize(signatureText, 14),
                maxSignatureWidth,
              ),
              height: 18,
            };
        const approvalText = approvalMention(
          new Date(sig.signedAt),
          markLanguage,
        );
        const approvalWidth = addMention
          ? Math.min(font.widthOfTextAtSize(approvalText, 9), maxSignatureWidth)
          : 0;
        const nameWidth = Math.min(
          fontBold.widthOfTextAtSize(signerName, 10),
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
        const drawRotation = normalizedPdfRotation(targetLayout.rotation);
        const contentOrigin = visualPdfPointToRaw(
          contentPosition,
          targetLayout,
        );

        targetPage.drawRectangle({
          x: contentOrigin.x,
          y: contentOrigin.y,
          width: contentWidth,
          height: contentHeight,
          rotate: degrees(drawRotation),
          color: rgb(1, 1, 1),
          opacity: 1,
          borderColor: rgb(0.7, 0.7, 0.7),
          borderWidth: 0.8,
        });

        if (addMention) {
          const approvalOrigin = visualPdfPointToRaw(
            {
              x: innerX,
              y: contentPosition.y + contentHeight - paddingY - 9,
            },
            targetLayout,
          );
          targetPage.drawText(approvalText, {
            x: approvalOrigin.x,
            y: approvalOrigin.y,
            size: 9,
            font,
            color: rgb(0, 0, 0),
            rotate: degrees(drawRotation),
          });
        }
        const nameOrigin = visualPdfPointToRaw(
          {
            x: innerX,
            y:
              contentPosition.y +
              contentHeight -
              paddingY -
              (addMention ? 26 : 12),
          },
          targetLayout,
        );
        targetPage.drawText(signerName, {
          x: nameOrigin.x,
          y: nameOrigin.y,
          size: 10,
          font: fontBold,
          color: rgb(0, 0, 0),
          rotate: degrees(drawRotation),
        });

        const imageOrigin = visualPdfPointToRaw(
          { x: innerX, y: sigImage ? imageY : imageY + 10 },
          targetLayout,
        );
        if (sigImage) {
          targetPage.drawImage(sigImage, {
            x: imageOrigin.x,
            y: imageOrigin.y,
            width: imageWidth,
            height: imageHeight,
            rotate: degrees(drawRotation),
          });
        } else {
          targetPage.drawText(signatureText, {
            x: imageOrigin.x,
            y: imageOrigin.y,
            size: 14,
            font,
            color: rgb(0.1, 0.1, 0.5),
            rotate: degrees(drawRotation),
          });
        }
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
      const cms = await signingService.signE2EDigest(
        docId,
        preparedPdf.digest,
        sourceSha256,
      );
      const padesSignedPdf = embedPadesCms(preparedPdf.bytes, cms);

      // 8. Re-encrypt the PAdES-signed PDF before any file upload
      const padesSignedBuffer = padesSignedPdf.buffer.slice(
        padesSignedPdf.byteOffset,
        padesSignedPdf.byteOffset + padesSignedPdf.byteLength,
      ) as ArrayBuffer;
      // A v2 source, a key with a v2 floor or the operator switch keeps the
      // signed result in v2, bound to this signing document.
      const reEncrypted =
        isContentV2(new Uint8Array(encryptedBuf)) ||
        contentWriteScheme(cryptoKey, contentPolicy().v2Writes) === 2
          ? (
              await encryptContentV2(
                cryptoKey,
                { signingDocumentId: docId },
                padesSignedPdf,
              )
            ).buffer
          : await encryptFile(padesSignedBuffer, cryptoKey);

      // 9. Upload encrypted final PDF for storage
      await signingService.finalizeE2E(
        docId,
        reEncrypted,
        await sha256Hex(padesSignedPdf),
        sourceSha256,
      );

      queryClient.invalidateQueries({ queryKey: ["signing.document", docId] });
      toast.success(t("signing.toast.finalize-success"));
    } catch {
      console.error("E2E finalization error");
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

  // Once its "where to save" prompt has been dismissed for good, a mobile
  // browser saves without any visible sign, so the reader is told where the
  // file went instead of seeing nothing happen.
  const saveProof = async (blob: Blob, fileName: string) => {
    if (await saveBlobToDevice(blob, fileName)) {
      toast.success(t("signing.toast.download-started"));
    }
  };

  const handleDownload = async () => {
    setDownloadingProof("signed");
    try {
      const blob = await signingService.downloadSigned(docId);
      let finalBlob = blob;

      // If E2E encrypted and we have the key, decrypt before saving
      if (doc?.isE2EEncrypted && e2eKeyB64) {
        const encryptedBuf = await blob.arrayBuffer();
        const cryptoKey = await importKeyFromBase64(e2eKeyB64);
        const decryptedBuf = await decryptFileAuto(
          encryptedBuf,
          cryptoKey,
          5_000_000,
          { signingDocumentId: docId },
        );
        finalBlob = new Blob([decryptedBuf], { type: "application/pdf" });
      }

      await saveProof(
        finalBlob,
        signedPdfName(doc?.fileName, signingLanguage(doc?.language)),
      );
    } catch {
      toast.error(t("signing.toast.download-error"));
    } finally {
      setDownloadingProof(null);
    }
  };

  const handleOwnForensicDownload = async () => {
    setDownloadingProof("forensic");
    try {
      const blob = await signingService.downloadOwnForensicRecord(docId);
      await saveProof(
        blob,
        `${doc?.fileName?.replace(/\.pdf$/i, "") || "document"}.my-forensic-record.json`,
      );
    } catch {
      toast.error(t("signing.toast.forensic-error"));
    } finally {
      setDownloadingProof(null);
    }
  };

  const handleEvidenceDownload = async () => {
    setDownloadingProof("evidence");
    try {
      const blob = await signingService.downloadEvidence(docId);
      await saveProof(
        blob,
        `${doc?.fileName?.replace(/\.pdf$/i, "") || "document"}.attestation.json`,
      );
    } catch {
      toast.error(t("signing.toast.evidence-error"));
    } finally {
      setDownloadingProof(null);
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

  const isPending = doc.status === "PENDING" || doc.status === "PARTIAL";
  const isAwaitingFinalization =
    !!doc.isRequester && doc.status === "AWAITING_FINALIZATION";
  // A failed sealing (TSA or certificate unavailable) can be retried.
  const canRetryServerFinalization =
    !!doc.isRequester &&
    (isAwaitingFinalization || doc.status === "SIGNING_FAILED");
  const fileDeleted = !!doc.fileDeleted;

  return (
    <>
      <Meta
        title={`${t("signing.title")} - ${doc.fileName || doc.title || t("signing.document")}`}
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
                    lineHeight: 1.2,
                  }}
                >
                  {doc.fileName || doc.title || t("signing.document")}
                </Text>
              </Group>
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              {t("signing.detail.created-at", {
                date: formatDateTime(doc.createdAt),
              })}
            </Text>
          </Box>
          <Badge
            color={statusColors[doc.status] || "gray"}
            size="lg"
            variant="light"
            style={{ flexShrink: 0 }}
          >
            {getStatusLabel(doc.status)}
          </Badge>
        </Group>

        {doc.message && (
          <Alert color="blue" mb="md" icon={<TbMail size={16} />}>
            <Text size="sm">{doc.message}</Text>
          </Alert>
        )}

        {fileDeleted && (
          <Alert color="orange" mb="md" icon={<TbFileOff size={16} />}>
            {t("signing.detail.file-deleted-warning")}
          </Alert>
        )}

        {/* Actions */}
        <Group mb="lg" gap="sm">
          <SigningActionButton action={doc.signingAction} e2eKey={e2eKeyB64} />
          {/* The signed PDF and its evidence outlive the source file. */}
          {doc.status === "COMPLETED" && (
            <Button
              leftSection={<TbDownload size={16} />}
              onClick={handleDownload}
              loading={downloadingProof === "signed"}
              disabled={doc.isE2EEncrypted && !e2eKeyB64}
              title={
                doc.isE2EEncrypted && !e2eKeyB64
                  ? t("signing.detail.finalize.e2e-unavailable")
                  : undefined
              }
            >
              {t("signing.actions.download")}
            </Button>
          )}
          {doc.status === "COMPLETED" &&
            doc.isE2EEncrypted &&
            !e2eKeyB64 &&
            doc.recipients?.some(
              (recipient: SignatureRecipient) => recipient.isCurrentUser,
            ) && (
              <Text size="xs" c="dimmed" w="100%">
                {t("signing.detail.download.e2e-open-link")}
              </Text>
            )}
          {/* The disabled button's title never shows on a touch screen. */}
          {doc.status === "COMPLETED" &&
            doc.isE2EEncrypted &&
            !e2eKeyB64 &&
            e2eKeyLookupDone &&
            !doc.recipients?.some(
              (recipient: SignatureRecipient) => recipient.isCurrentUser,
            ) && (
              <Text size="xs" c="dimmed" w="100%">
                {t("signing.detail.finalize.e2e-unavailable")}
              </Text>
            )}
          {doc.status === "COMPLETED" && (
            <Button
              variant="light"
              leftSection={<TbShieldCheck size={16} />}
              onClick={handleEvidenceDownload}
              loading={downloadingProof === "evidence"}
            >
              {t("signing.detail.evidence.download")}
            </Button>
          )}
          {doc.recipients?.some(
            (r) => r.isCurrentUser && ["SIGNED", "REJECTED"].includes(r.status),
          ) && (
            <Button
              variant="subtle"
              leftSection={<TbLock size={16} />}
              onClick={handleOwnForensicDownload}
              loading={downloadingProof === "forensic"}
            >
              {t("signing.detail.forensic.download")}
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
            doc.isE2EEncrypted && (
              <Alert color="yellow" icon={<TbLock size={16} />}>
                {t("signing.detail.finalize.key-resolving")}
              </Alert>
            )}
          {isAwaitingFinalization &&
            !fileDeleted &&
            !finalizing &&
            doc.isE2EEncrypted &&
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
          {canRetryServerFinalization &&
            !fileDeleted &&
            !finalizing &&
            !doc.isE2EEncrypted && (
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
                      queryKey: ["signing.document", docId, user?.id],
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
          {doc.isRequester && isPending && !fileDeleted && (
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
        {doc.isRequester &&
          !fileDeleted &&
          doc.recipients?.some((r) => r.signingToken && r.role !== "CC") && (
            <Paper withBorder p="md" mb="lg">
              <Text fw={600} mb="sm">
                <Group gap="xs">
                  <TbLink size={16} /> {t("signing.detail.signing-links")}
                </Group>
              </Text>
              <Text size="xs" c="dimmed" mb="md">
                {doc.status === "COMPLETED"
                  ? t("signing.detail.signing-links.completed-desc")
                  : t("signing.detail.signing-links.desc")}
              </Text>
              <Stack gap="xs">
                {doc.recipients
                  .filter((r) => r.signingToken && r.role !== "CC")
                  .map((r) => {
                    const keyFragment =
                      doc.isE2EEncrypted && e2eKeyB64
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
              {doc.recipients?.map((r) => (
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
                {doc.recipients?.map((r) => (
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
        {!!doc.auditTrail?.length && (
          <Paper withBorder p="md">
            <Text fw={600} mb="md">
              <Group gap="xs">
                <TbShieldCheck size={16} /> {t("signing.detail.audit-trail")}
              </Group>
            </Text>
            <Timeline active={doc.auditTrail.length - 1} bulletSize={20}>
              {doc.auditTrail.map((event) => {
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
                // Some events are attributed to "system" or to an internal
                // account id, only an e-mail address is worth displaying.
                const actorEmail = String(event.actor || "").includes("@")
                  ? event.actor
                  : "";
                const actionKey = actionKeyMap[event.eventType];
                const actionLabel = actionKey
                  ? t(actionKey, { email: actorEmail })
                  : event.eventType;

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
                      {actorEmail && (
                        <Text size="xs" c="dimmed">
                          {t("signing.detail.audit.actor", {
                            email: actorEmail,
                          })}
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
