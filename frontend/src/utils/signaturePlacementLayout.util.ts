import type { VectorShape } from "./pdfVectorGeometry.util";
import {
  isPrefilledSignatureLabel,
  isSignaturePlacementLabel,
  placeSignatureBesideTextAnchor,
  signatureLabelStrength,
  scoreSignatureAnchorContext,
  type PlacementBox,
} from "./signaturePlacementLabel.util";

export type PlacementTextItem = PlacementBox & { text: string };

export type PlacementStrategy = "box" | "rule" | "anchor" | "geometry";

export type PlacementCandidate = PlacementBox & {
  strategy: PlacementStrategy;
  confidence: number;
};

export type PlacementInput = {
  textItems: PlacementTextItem[];
  shapes: VectorShape[];
  pageWidth: number;
  pageHeight: number;
  preferredWidth: number;
  preferredHeight: number;
};

const MIN_WIDTH = 85;
/** Below this, a guess is worse than the caller's own bottom-right default. */
const MIN_ANCHOR_CONFIDENCE = 0.3;
const MIN_HEIGHT = 34;
const BOX_PADDING = 6;
const FIELD_GAP = 8;

const right = (box: PlacementBox) => box.left + box.width;
const bottom = (box: PlacementBox) => box.top + box.height;
const area = (box: PlacementBox) => box.width * box.height;

const spanOverlap = (
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
) => Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart);

const containsCenter = (item: PlacementBox, container: PlacementBox) => {
  const centerX = item.left + item.width / 2;
  const centerY = item.top + item.height / 2;
  return (
    centerX >= container.left &&
    centerX <= right(container) &&
    centerY >= container.top &&
    centerY <= bottom(container)
  );
};

const clampToPage = (
  box: PlacementBox,
  pageWidth: number,
  pageHeight: number,
): PlacementBox => {
  const width = Math.min(box.width, pageWidth);
  const height = Math.min(box.height, pageHeight);
  return {
    left: Math.max(0, Math.min(box.left, pageWidth - width)),
    top: Math.max(0, Math.min(box.top, pageHeight - height)),
    width,
    height,
  };
};

const innerBox = (rectangle: PlacementBox): PlacementBox => ({
  left: rectangle.left + BOX_PADDING,
  top: rectangle.top + BOX_PADDING,
  width: rectangle.width - BOX_PADDING * 2,
  height: rectangle.height - BOX_PADDING * 2,
});

/**
 * Drop the signature into the free part of the frame that holds the anchor:
 * to the right of the labels when that column is wide enough, otherwise under
 * every label the frame contains. The result never leaves the frame, which is
 * what made the previous "beside the anchor" placement overflow the box.
 */
export const placeSignatureInsideBox = (
  anchor: PlacementBox,
  rectangle: PlacementBox,
  siblings: PlacementBox[],
  preferredWidth: number,
  preferredHeight: number,
): PlacementBox | null => {
  const inner = innerBox(rectangle);
  if (inner.width < MIN_WIDTH * 0.6 || inner.height < MIN_HEIGHT) return null;

  const rowTop = anchor.top - anchor.height * 0.6;
  const rowBottom = bottom(anchor) + anchor.height * 0.6;
  const rowRight = siblings.reduce(
    (edge, sibling) =>
      spanOverlap(sibling.top, bottom(sibling), rowTop, rowBottom) > 0
        ? Math.max(edge, right(sibling))
        : edge,
    right(anchor),
  );

  const besideLeft = Math.max(inner.left, rowRight + FIELD_GAP);
  const besideWidth = right(inner) - besideLeft;
  if (besideWidth >= MIN_WIDTH) {
    const height = Math.min(preferredHeight, inner.height);
    const centered = anchor.top + anchor.height / 2 - height / 2;
    return {
      left: besideLeft,
      top: Math.max(inner.top, Math.min(centered, bottom(inner) - height)),
      width: Math.min(preferredWidth, besideWidth),
      height,
    };
  }

  const labelsBottom = siblings.reduce(
    (edge, sibling) => Math.max(edge, bottom(sibling)),
    bottom(anchor),
  );
  const belowTop = Math.max(inner.top, labelsBottom + FIELD_GAP / 2);
  const belowHeight = bottom(inner) - belowTop;
  if (belowHeight >= MIN_HEIGHT) {
    return {
      left: inner.left,
      top: belowTop,
      width: Math.min(preferredWidth, inner.width),
      height: Math.min(preferredHeight, belowHeight),
    };
  }

  return {
    left: inner.left,
    top: inner.top,
    width: Math.min(preferredWidth, inner.width),
    height: Math.min(preferredHeight, inner.height),
  };
};

/** Sit the signature on the ruled line that follows the anchor. */
export const placeSignatureOnRule = (
  anchor: PlacementBox,
  rule: PlacementBox,
  textItems: PlacementBox[],
  preferredWidth: number,
  preferredHeight: number,
): PlacementBox | null => {
  const baseline = rule.top - 1;
  const ceiling = textItems.reduce(
    (edge, item) => {
      const overlapsRule =
        spanOverlap(item.left, right(item), rule.left, right(rule)) > 0;
      return overlapsRule && bottom(item) <= baseline
        ? Math.max(edge, bottom(item))
        : edge;
    },
    bottom(anchor) <= baseline ? bottom(anchor) : 0,
  );

  const top = Math.max(ceiling + FIELD_GAP / 2, baseline - preferredHeight);
  const height = baseline - top;
  if (height < MIN_HEIGHT * 0.4) return null;

  const sameRow =
    spanOverlap(anchor.top, bottom(anchor), rule.top - 4, rule.top + 4) > 0;
  const left = Math.max(
    rule.left + 2,
    sameRow ? right(anchor) + FIELD_GAP : rule.left + 2,
  );
  const width = Math.min(preferredWidth, right(rule) - left);
  if (width < MIN_WIDTH) return null;

  return { left, top, width, height };
};

/**
 * A contract usually shows two identical blocks, one already filled in by the
 * issuer. The recipient signs the empty one, so the emptier frame wins.
 */
const emptinessScore = (
  rectangle: PlacementBox,
  textItems: PlacementTextItem[],
  shapes: VectorShape[],
) => {
  const occupants = textItems.filter(
    (item) => containsCenter(item, rectangle) && item.text.trim().length > 0,
  );
  const prefilled = occupants.some((item) =>
    isPrefilledSignatureLabel(item.text),
  );
  const ink = shapes.filter(
    (shape) => shape.kind === "rectangle" && containsCenter(shape, rectangle),
  ).length;
  const density = (occupants.length + ink * 2) / 12;
  return Math.max(0, 1 - density) - (prefilled ? 0.6 : 0);
};

const enclosingRectangle = (
  anchor: PlacementBox,
  rectangles: VectorShape[],
  pageWidth: number,
  pageHeight: number,
) =>
  rectangles
    .filter(
      (rectangle) =>
        containsCenter(anchor, rectangle) &&
        rectangle.width >= MIN_WIDTH * 0.6 &&
        rectangle.height >= MIN_HEIGHT &&
        area(rectangle) <= pageWidth * pageHeight * 0.55,
    )
    .sort((first, second) => area(first) - area(second))[0];

const nearestRuleBelow = (anchor: PlacementBox, rules: VectorShape[]) =>
  rules
    .filter((rule) => {
      const distance = rule.top - bottom(anchor);
      const horizontallyClose =
        spanOverlap(
          rule.left,
          right(rule),
          anchor.left - 40,
          right(anchor) + 320,
        ) > 0;
      return (
        distance >= -anchor.height &&
        distance <= anchor.height * 6 &&
        horizontallyClose
      );
    })
    .sort((first, second) => first.top - second.top)[0];

/**
 * Pick where the signature should land on one page. Everything is expressed in
 * viewport points with a top-left origin, so page rotation is already applied
 * by the caller's viewport.
 */
export function chooseSignaturePlacement(
  input: PlacementInput,
): PlacementCandidate | null {
  const {
    textItems,
    shapes,
    pageWidth,
    pageHeight,
    preferredWidth,
    preferredHeight,
  } = input;
  const rectangles = shapes.filter((shape) => shape.kind === "rectangle");
  const rules = shapes.filter((shape) => shape.kind === "horizontal-rule");
  const anchors = textItems.filter((item) =>
    isSignaturePlacementLabel(item.text),
  );

  const candidates: PlacementCandidate[] = [];

  for (const anchor of anchors) {
    const verticalBonus = (bottom(anchor) / pageHeight) * 0.12;
    // Counterparty blocks sit to the right of the issuer's own block, so a tie
    // between two equally empty frames goes to the rightmost one.
    const horizontalBonus = (right(anchor) / pageWidth) * 0.03;
    const prose = (1 - signatureLabelStrength(anchor.text)) * 0.3;
    const context =
      Math.min(scoreSignatureAnchorContext(anchor, textItems), 2) * 0.09;
    const rectangle = enclosingRectangle(
      anchor,
      rectangles,
      pageWidth,
      pageHeight,
    );

    if (rectangle) {
      const siblings = textItems.filter(
        (item) => item !== anchor && containsCenter(item, rectangle),
      );
      const placement = placeSignatureInsideBox(
        anchor,
        rectangle,
        siblings,
        preferredWidth,
        preferredHeight,
      );
      if (placement) {
        candidates.push({
          ...placement,
          strategy: "box",
          confidence:
            0.72 +
            context +
            verticalBonus +
            horizontalBonus -
            prose +
            emptinessScore(rectangle, textItems, shapes) * 0.1,
        });
        continue;
      }
    }

    const rule = nearestRuleBelow(anchor, rules);
    if (rule) {
      const placement = placeSignatureOnRule(
        anchor,
        rule,
        textItems,
        preferredWidth,
        preferredHeight,
      );
      if (placement) {
        candidates.push({
          ...placement,
          strategy: "rule",
          confidence: 0.55 + context + verticalBonus + horizontalBonus - prose,
        });
        continue;
      }
    }

    const beside = placeSignatureBesideTextAnchor(anchor);
    candidates.push({
      ...clampToPage(
        {
          left: beside.left,
          top: beside.top,
          width: preferredWidth,
          height: preferredHeight,
        },
        pageWidth,
        pageHeight,
      ),
      strategy: "anchor",
      confidence: 0.3 + context + verticalBonus + horizontalBonus - prose,
    });
  }

  if (candidates.length === 0) {
    const empty = rectangles
      .filter(
        (rectangle) =>
          rectangle.width >= MIN_WIDTH &&
          rectangle.height >= MIN_HEIGHT &&
          area(rectangle) <= pageWidth * pageHeight * 0.45 &&
          bottom(rectangle) >= pageHeight * 0.45 &&
          !textItems.some(
            (item) =>
              item.text.trim().length > 0 && containsCenter(item, rectangle),
          ),
      )
      .sort(
        (first, second) =>
          bottom(second) - bottom(first) || right(second) - right(first),
      )[0];
    if (!empty) return null;
    const inner = innerBox(empty);
    return {
      left: inner.left,
      top: inner.top,
      width: Math.min(preferredWidth, inner.width),
      height: Math.min(preferredHeight, inner.height),
      strategy: "geometry",
      confidence: 0.4,
    };
  }

  const best = candidates.sort(
    (first, second) => second.confidence - first.confidence,
  )[0];
  if (best.strategy === "anchor" && best.confidence < MIN_ANCHOR_CONFIDENCE) {
    return null;
  }
  return {
    ...clampToPage(best, pageWidth, pageHeight),
    strategy: best.strategy,
    confidence: Math.min(1, best.confidence),
  };
}
