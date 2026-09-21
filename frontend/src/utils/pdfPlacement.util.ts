export const PDF_POINTS_PER_MILLIMETER = 72 / 25.4;

export const DEFAULT_PDF_PAGE = {
  widthPoints: 595,
  heightPoints: 842,
};

export const DEFAULT_PAGE_MARGIN_MM = 12.7;
export const DEFAULT_FIELD_GAP_MM = 4.2;
export const DEFAULT_SIGNATURE_FIELD_MM = { width: 84.7, height: 28.2 };
export const DEFAULT_TEXT_FIELD_MM = { width: 84.7, height: 31.8 };

export type PdfPageLayout = {
  widthPoints: number;
  heightPoints: number;
  rotation: number;
};

export type PdfFieldMillimeters = {
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
};

export type PdfFieldPlacement =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type InitialsPlacement =
  | "BOTTOM_LEFT"
  | "BOTTOM_CENTER_RIGHT"
  | "BOTTOM_RIGHT";

const finiteOr = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

const roundedMillimeters = (value: number) =>
  Math.round((value + Number.EPSILON) * 10) / 10;

export const pointsToMillimeters = (points: number) =>
  roundedMillimeters(points / PDF_POINTS_PER_MILLIMETER);

export const millimetersToPoints = (millimeters: number) =>
  (finiteOr(millimeters, 0) * 72) / 25.4;

export const normalizedPdfRotation = (rotation: number) =>
  ((Math.round(finiteOr(rotation, 0) / 90) * 90) % 360 + 360) % 360;

/** Dimensions as displayed by a PDF viewer, after the page /Rotate is applied. */
export const pageSizePoints = (page: PdfPageLayout) => {
  const rotation = normalizedPdfRotation(page.rotation);
  const swapsAxes = rotation === 90 || rotation === 270;
  return {
    width: swapsAxes ? page.heightPoints : page.widthPoints,
    height: swapsAxes ? page.widthPoints : page.heightPoints,
  };
};

export const pageSizeMillimeters = (page: PdfPageLayout) => {
  const visual = pageSizePoints(page);
  return {
    widthMm: pointsToMillimeters(visual.width),
    heightMm: pointsToMillimeters(visual.height),
  };
};

export const getPlacementInMillimeters = (
  placement: PdfFieldPlacement,
  page: PdfPageLayout,
  field: Pick<PdfFieldMillimeters, "widthMm" | "heightMm">,
): Pick<PdfFieldMillimeters, "leftMm" | "topMm"> => {
  const { widthMm: pageWidthMm, heightMm: pageHeightMm } =
    pageSizeMillimeters(page);
  const widthMm = Math.min(
    Math.max(finiteOr(field.widthMm, 1), 1),
    pageWidthMm,
  );
  const heightMm = Math.min(
    Math.max(finiteOr(field.heightMm, 1), 1),
    pageHeightMm,
  );
  const [vertical, horizontal] = placement.split("-");
  const leftMm =
    horizontal === "left"
      ? DEFAULT_PAGE_MARGIN_MM
      : horizontal === "center"
        ? (pageWidthMm - widthMm) / 2
        : pageWidthMm - widthMm - DEFAULT_PAGE_MARGIN_MM;
  const topMm =
    vertical === "top"
      ? DEFAULT_PAGE_MARGIN_MM
      : vertical === "middle"
        ? (pageHeightMm - heightMm) / 2
        : pageHeightMm - heightMm - DEFAULT_PAGE_MARGIN_MM;

  return {
    leftMm: roundedMillimeters(Math.max(0, leftMm)),
    topMm: roundedMillimeters(Math.max(0, topMm)),
  };
};

export const clampFieldToPage = (
  field: PdfFieldMillimeters,
  page: PdfPageLayout,
): PdfFieldMillimeters => {
  const { widthMm: pageWidthMm, heightMm: pageHeightMm } =
    pageSizeMillimeters(page);
  const widthMm = roundedMillimeters(
    Math.min(Math.max(finiteOr(field.widthMm, 1), 1), pageWidthMm),
  );
  const heightMm = roundedMillimeters(
    Math.min(Math.max(finiteOr(field.heightMm, 1), 1), pageHeightMm),
  );

  return {
    leftMm: roundedMillimeters(
      Math.min(Math.max(finiteOr(field.leftMm, 0), 0), pageWidthMm - widthMm),
    ),
    topMm: roundedMillimeters(
      Math.min(Math.max(finiteOr(field.topMm, 0), 0), pageHeightMm - heightMm),
    ),
    widthMm,
    heightMm,
  };
};

export const fieldMillimetersToPdfPoints = (
  field: PdfFieldMillimeters,
  page: PdfPageLayout,
) => {
  const safe = clampFieldToPage(field, page);
  const left = millimetersToPoints(safe.leftMm);
  const top = millimetersToPoints(safe.topMm);
  const visualWidth = millimetersToPoints(safe.widthMm);
  const visualHeight = millimetersToPoints(safe.heightMm);

  // Form coordinates use the viewer's visual top-left origin. PDF drawing uses
  // the unrotated page's bottom-left origin, even when /Rotate is 90/180/270.
  // Convert the whole rectangle so presets and manual placement land at the
  // same visual position on every page orientation.
  switch (normalizedPdfRotation(page.rotation)) {
    case 90:
      return {
        posX: top,
        posY: left,
        width: visualHeight,
        height: visualWidth,
      };
    case 180:
      return {
        posX: Math.max(0, page.widthPoints - left - visualWidth),
        posY: top,
        width: visualWidth,
        height: visualHeight,
      };
    case 270:
      return {
        posX: Math.max(0, page.widthPoints - top - visualHeight),
        posY: Math.max(0, page.heightPoints - left - visualWidth),
        width: visualHeight,
        height: visualWidth,
      };
    default:
      return {
        posX: left,
        posY: Math.max(0, page.heightPoints - top - visualHeight),
        width: visualWidth,
        height: visualHeight,
      };
  }
};

export const rawPdfBoxToVisual = (
  box: { x: number; y: number; width: number; height: number },
  page: PdfPageLayout,
) => {
  switch (normalizedPdfRotation(page.rotation)) {
    case 90:
      return {
        x: box.y,
        y: page.widthPoints - box.x - box.width,
        width: box.height,
        height: box.width,
      };
    case 180:
      return {
        x: page.widthPoints - box.x - box.width,
        y: page.heightPoints - box.y - box.height,
        width: box.width,
        height: box.height,
      };
    case 270:
      return {
        x: page.heightPoints - box.y - box.height,
        y: box.x,
        width: box.height,
        height: box.width,
      };
    default:
      return box;
  }
};

export const visualPdfPointToRaw = (
  point: { x: number; y: number },
  page: PdfPageLayout,
) => {
  switch (normalizedPdfRotation(page.rotation)) {
    case 90:
      return { x: page.widthPoints - point.y, y: point.x };
    case 180:
      return {
        x: page.widthPoints - point.x,
        y: page.heightPoints - point.y,
      };
    case 270:
      return { x: point.y, y: page.heightPoints - point.x };
    default:
      return point;
  }
};

export const fieldFitsPage = (
  field: PdfFieldMillimeters,
  page: PdfPageLayout,
) => {
  const { widthMm: pageWidthMm, heightMm: pageHeightMm } =
    pageSizeMillimeters(page);
  return (
    Number.isFinite(field.leftMm) &&
    Number.isFinite(field.topMm) &&
    Number.isFinite(field.widthMm) &&
    Number.isFinite(field.heightMm) &&
    field.leftMm >= 0 &&
    field.topMm >= 0 &&
    field.widthMm > 0 &&
    field.heightMm > 0 &&
    field.leftMm + field.widthMm <= pageWidthMm + 0.05 &&
    field.topMm + field.heightMm <= pageHeightMm + 0.05
  );
};

export const getInitialsStampGeometry = (args: {
  pageWidth: number;
  pageHeight: number;
  textWidth: number;
  fontSize?: number;
  placement?: InitialsPlacement | string | null;
}) => {
  const fontSize = Math.min(Math.max(args.fontSize ?? 9, 6), 12);
  const sideMargin = millimetersToPoints(12.7);
  const boxWidth = Math.min(
    Math.max(args.textWidth + 10, 28),
    Math.max(28, args.pageWidth - sideMargin * 2),
  );
  const boxHeight = fontSize + 7;
  const requestedX =
    args.placement === "BOTTOM_LEFT"
      ? sideMargin
      : args.placement === "BOTTOM_RIGHT"
        ? args.pageWidth - sideMargin - boxWidth
        : args.pageWidth * 0.68 - boxWidth / 2;
  return {
    x: Math.min(Math.max(requestedX, 0), args.pageWidth - boxWidth),
    y: Math.min(
      millimetersToPoints(14),
      Math.max(0, args.pageHeight - boxHeight),
    ),
    width: boxWidth,
    height: boxHeight,
    textXOffset: 5,
    textYOffset: 4,
    fontSize,
  };
};

export const shouldAddInitialsToPage = (args: {
  pageIndex: number;
  signaturePage?: number | null;
  includeSignaturePage?: boolean;
}) =>
  args.includeSignaturePage === true ||
  args.pageIndex !== Math.max(0, (args.signaturePage ?? 1) - 1);
