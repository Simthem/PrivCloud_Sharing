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

export const pageSizeMillimeters = (page: PdfPageLayout) => ({
  widthMm: pointsToMillimeters(page.widthPoints),
  heightMm: pointsToMillimeters(page.heightPoints),
});

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
  const width = millimetersToPoints(safe.widthMm);
  const height = millimetersToPoints(safe.heightMm);
  return {
    posX: millimetersToPoints(safe.leftMm),
    posY: Math.max(
      0,
      page.heightPoints - millimetersToPoints(safe.topMm) - height,
    ),
    width,
    height,
  };
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
