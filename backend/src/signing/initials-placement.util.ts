export const INITIALS_PLACEMENTS = [
  "BOTTOM_LEFT",
  "BOTTOM_CENTER_RIGHT",
  "BOTTOM_RIGHT",
] as const;

export type InitialsPlacement = (typeof INITIALS_PLACEMENTS)[number];

const POINTS_PER_MILLIMETER = 72 / 25.4;
const BOTTOM_SAFE_MARGIN = 14 * POINTS_PER_MILLIMETER;
const SIDE_SAFE_MARGIN = 12.7 * POINTS_PER_MILLIMETER;
const HORIZONTAL_PADDING = 5;
const VERTICAL_PADDING = 3;

export const normalizeInitialsPlacement = (
  placement?: string | null,
): InitialsPlacement =>
  INITIALS_PLACEMENTS.includes(placement as InitialsPlacement)
    ? (placement as InitialsPlacement)
    : "BOTTOM_CENTER_RIGHT";

export const getInitialsStampGeometry = (args: {
  pageWidth: number;
  pageHeight: number;
  textWidth: number;
  fontSize?: number;
  placement?: string | null;
}) => {
  const fontSize = Math.min(Math.max(args.fontSize ?? 9, 6), 12);
  const boxWidth = Math.min(
    Math.max(args.textWidth + HORIZONTAL_PADDING * 2, 28),
    Math.max(28, args.pageWidth - SIDE_SAFE_MARGIN * 2),
  );
  const boxHeight = fontSize + VERTICAL_PADDING * 2 + 1;
  const placement = normalizeInitialsPlacement(args.placement);
  const requestedX =
    placement === "BOTTOM_LEFT"
      ? SIDE_SAFE_MARGIN
      : placement === "BOTTOM_RIGHT"
        ? args.pageWidth - SIDE_SAFE_MARGIN - boxWidth
        : args.pageWidth * 0.68 - boxWidth / 2;

  return {
    x: Math.min(Math.max(requestedX, 0), args.pageWidth - boxWidth),
    y: Math.min(
      Math.max(BOTTOM_SAFE_MARGIN, 0),
      Math.max(0, args.pageHeight - boxHeight),
    ),
    width: boxWidth,
    height: boxHeight,
    textXOffset: HORIZONTAL_PADDING,
    textYOffset: VERTICAL_PADDING + 1,
    fontSize,
    placement,
  };
};

export const shouldAddInitialsToPage = (args: {
  pageIndex: number;
  signaturePage?: number | null;
  includeSignaturePage?: boolean;
}) =>
  args.includeSignaturePage === true ||
  args.pageIndex !== Math.max(0, (args.signaturePage ?? 1) - 1);
