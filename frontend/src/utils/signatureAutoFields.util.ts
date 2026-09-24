import {
  PDF_POINTS_PER_MILLIMETER,
  type PdfFieldMillimeters,
} from "./pdfPlacement.util";
import {
  MIN_SIGNATURE_SLOT_POINTS,
  SIGNATURE_SLOT_GAP_POINTS,
  splitSignatureArea,
} from "./signatureSlots.util";

export type AutoSignatureField = PdfFieldMillimeters & {
  recipientEmail: string;
};

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Turns the detected signature area into one block per signer, so that every
 * handwritten or uploaded signature has room of its own. Blocks never leave the
 * page, and an area too small for all signers grows into a grid of blocks of
 * the minimum readable size.
 */
export function buildAutoSignatureFields(
  detected: PdfFieldMillimeters,
  signerEmails: string[],
  page: { widthMm: number; heightMm: number },
): AutoSignatureField[] {
  const emails = signerEmails.length > 0 ? signerEmails : [""];
  const areas = splitSignatureArea(
    {
      x: detected.leftMm,
      y: detected.topMm,
      width: detected.widthMm,
      height: detected.heightMm,
    },
    emails.length,
    {
      minWidth: MIN_SIGNATURE_SLOT_POINTS.width / PDF_POINTS_PER_MILLIMETER,
      minHeight: MIN_SIGNATURE_SLOT_POINTS.height / PDF_POINTS_PER_MILLIMETER,
      gap: SIGNATURE_SLOT_GAP_POINTS / PDF_POINTS_PER_MILLIMETER,
      yAxis: "down",
    },
  );
  const overflow = Math.max(
    0,
    ...areas.map((area) => area.y + area.height - page.heightMm),
  );
  return emails.map((recipientEmail, index) => {
    const area = areas[index];
    const widthMm = Math.min(area.width, page.widthMm);
    const heightMm = Math.min(area.height, page.heightMm);
    return {
      recipientEmail,
      leftMm: round(Math.max(0, Math.min(area.x, page.widthMm - widthMm))),
      topMm: round(Math.max(0, area.y - overflow)),
      widthMm: round(widthMm),
      heightMm: round(heightMm),
    };
  });
}
