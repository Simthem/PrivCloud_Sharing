export interface PdfPageGeometry {
  width: number;
  height: number;
  rotation: number;
}

export interface PdfBoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageRotation {
  page: number;
  rotation: number;
}

export const normalizedPdfRotation = (rotation: number) =>
  ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;

/** Apply requester-selected clockwise rotations without mutating the source file. */
export async function applyPdfPageRotations(
  pdfBuffer: Buffer,
  rotations: PdfPageRotation[] | null | undefined,
): Promise<Buffer> {
  if (!rotations?.length) return pdfBuffer;
  const { PDFDocument, degrees } = await import("pdf-lib");
  const pdf = await PDFDocument.load(pdfBuffer);
  const pages = pdf.getPages();
  for (const entry of rotations) {
    const page = pages[entry.page - 1];
    if (!page) continue;
    page.setRotation(
      degrees(normalizedPdfRotation(page.getRotation().angle + entry.rotation)),
    );
  }
  return Buffer.from(await pdf.save());
}

export function visualPageSize(page: PdfPageGeometry) {
  const rotation = normalizedPdfRotation(page.rotation);
  return rotation === 90 || rotation === 270
    ? { width: page.height, height: page.width }
    : { width: page.width, height: page.height };
}

/** Convert a stored raw-PDF box to viewer coordinates with a bottom-left origin. */
export function rawPdfBoxToVisual(
  box: PdfBoxGeometry,
  page: PdfPageGeometry,
): PdfBoxGeometry {
  switch (normalizedPdfRotation(page.rotation)) {
    case 90:
      return {
        x: box.y,
        y: page.width - box.x - box.width,
        width: box.height,
        height: box.width,
      };
    case 180:
      return {
        x: page.width - box.x - box.width,
        y: page.height - box.y - box.height,
        width: box.width,
        height: box.height,
      };
    case 270:
      return {
        x: page.height - box.y - box.height,
        y: box.x,
        width: box.height,
        height: box.width,
      };
    default:
      return box;
  }
}

/** Map a visual bottom-left point to the PDF page's unrotated user space. */
export function visualPdfPointToRaw(
  point: { x: number; y: number },
  page: PdfPageGeometry,
) {
  switch (normalizedPdfRotation(page.rotation)) {
    case 90:
      return { x: page.width - point.y, y: point.x };
    case 180:
      return { x: page.width - point.x, y: page.height - point.y };
    case 270:
      return { x: point.y, y: page.height - point.x };
    default:
      return point;
  }
}
