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
import signingService, {
  SignatureRecipient,
} from "../../services/signing.service";
import shareService from "../../services/share.service";
import teamService from "../../services/team.service";
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
  normalizedPdfRotation,
  pageSizePoints,
  rawPdfBoxToVisual,
  shouldAddInitialsToPage,
  visualPdfPointToRaw,
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
    const ownWrappedKey: string | undefined = typedDoc?.recipients?.find(
      (recipient: SignatureRecipient) =>
        recipient.isCurrentUser && recipient.wrappedE2EKey,
    )?.wrappedE2EKey;
    // Need at least one resolution path
    if (!ownWrappedKey && !typedDoc?.teamId && !typedDoc?.shareId) return;

    (async () => {
      try {
        const userKeyB64 = getUserKey();
        if (!userKeyB64) return;
        const masterKey = await importKeyFromBase64(userKeyB64);

        if (ownWrappedKey) {
          // Path 0: signer, key kept for this account when the link was opened
          const documentKey = await unwrapReverseShareKey(
            ownWrappedKey,
            masterKey,
          );
          setE2eKeyB64(await exportKeyToBase64(documentKey));
        } else if (typedDoc.teamId) {
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
    typedDoc?.recipients,
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

      // 3b. Rebuild every signer's contribution locally and refuse to seal
      // anything a signer did not approve with WebAuthn.
      const sourceSha256 = await sha256Hex(new Uint8Array(decryptedBuf));
      if (sigData.signatureLevel === "REINFORCED") {
        const problems = await reconcileSignerContributions({
          documentId: docId,
          sourceSha256,
          signers: sigData.signers,
          fieldValues: (sigData.fields || []).flatMap(
            (field: any) => field.fieldValues || [],
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
      await pdfDoc.attach(new Uint8Array(decryptedBuf), "privcloud-source.pdf", {
        mimeType: "application/pdf",
        description: `Source document SHA-256 ${sourceSha256}`,
      });
      for (const entry of Array.isArray(sigData.pageRotations)
        ? sigData.pageRotations
        : []) {
        const page = pdfDoc.getPages()[entry.page - 1];
        if (page && [90, 180, 270].includes(entry.rotation)) {
          page.setRotation(
            degrees(normalizedPdfRotation(page.getRotation().angle + entry.rotation)),
          );
        }
      }
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
        wmPage.drawText("Bon pour Accord", {
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
            .map((s: any) =>
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
        (sigData.signers || []).map((sig: any) => sig.id),
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
      const reEncrypted = await encryptFile(padesSignedBuffer, cryptoKey);

      // 9. Upload encrypted final PDF for storage
      await signingService.finalizeE2E(
        docId,
        reEncrypted,
        await sha256Hex(padesSignedPdf),
        sourceSha256,
      );

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

  const handleOwnForensicDownload = async () => {
    try {
      const blob = await signingService.downloadOwnForensicRecord(docId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(doc as any)?.fileName?.replace(/\.pdf$/i, "") || "document"}.my-forensic-record.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("signing.toast.forensic-error"));
    }
  };

  const handleEvidenceDownload = async () => {
    try {
      const blob = await signingService.downloadEvidence(docId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(doc as any)?.fileName?.replace(/\.pdf$/i, "") || "document"}.attestation.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("signing.toast.evidence-error"));
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
  // A failed sealing (TSA or certificate unavailable) can be retried.
  const canRetryServerFinalization =
    isAwaitingFinalization || typedDoc.status === "SIGNING_FAILED";
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
          {/* The signed PDF and its evidence outlive the source file. */}
          {typedDoc.status === "COMPLETED" && (
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
          {typedDoc.status === "COMPLETED" &&
            typedDoc.isE2EEncrypted &&
            !e2eKeyB64 &&
            typedDoc.recipients?.some(
              (recipient: SignatureRecipient) => recipient.isCurrentUser,
            ) && (
              <Text size="xs" c="dimmed" w="100%">
                {t("signing.detail.download.e2e-open-link")}
              </Text>
            )}
          {typedDoc.status === "COMPLETED" && (
            <Button
              variant="light"
              leftSection={<TbShieldCheck size={16} />}
              onClick={handleEvidenceDownload}
            >
              {t("signing.detail.evidence.download")}
            </Button>
          )}
          {typedDoc.recipients?.some(
            (r: any) =>
              r.isCurrentUser && ["SIGNED", "REJECTED"].includes(r.status),
          ) && (
            <Button
              variant="subtle"
              leftSection={<TbLock size={16} />}
              onClick={handleOwnForensicDownload}
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
          {canRetryServerFinalization &&
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
