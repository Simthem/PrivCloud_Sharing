import type { PlacementBox } from "./signaturePlacementLabel.util";

type PdfjsModule = typeof import("pdfjs-dist");

type OperatorList = {
  fnArray: number[] | Uint8Array;
  argsArray: unknown[];
};

export type VectorShape = PlacementBox & {
  kind: "rectangle" | "horizontal-rule" | "vertical-rule";
};

/** Operator lists of heavily illustrated pages are capped: signature areas are
 *  simple frames, and an unbounded scan would stall the request modal. */
const MAX_OPERATORS = 60_000;
const MAX_SHAPES = 3_000;
const RULE_THICKNESS = 2.5;
const MIN_RULE_LENGTH = 18;
const MIN_RECTANGLE_SIDE = 12;
const CORNER_TOLERANCE = 2.5;

const applyMatrix = (matrix: number[], x: number, y: number) => [
  matrix[0] * x + matrix[2] * y + matrix[4],
  matrix[1] * x + matrix[3] * y + matrix[5],
];

const classify = (
  left: number,
  top: number,
  width: number,
  height: number,
): VectorShape | null => {
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  if (height <= RULE_THICKNESS && width >= MIN_RULE_LENGTH) {
    return { left, top, width, height, kind: "horizontal-rule" };
  }
  if (width <= RULE_THICKNESS && height >= MIN_RULE_LENGTH) {
    return { left, top, width, height, kind: "vertical-rule" };
  }
  if (width >= MIN_RECTANGLE_SIDE && height >= MIN_RECTANGLE_SIDE) {
    return { left, top, width, height, kind: "rectangle" };
  }
  return null;
};

/** A closed four or five point straight subpath whose corners are axis aligned
 *  is the frame most PDF generators emit instead of a single `re` operator. */
const isAxisAlignedQuad = (points: number[][]) => {
  const corners =
    points.length === 5 &&
    Math.abs(points[0][0] - points[4][0]) <= CORNER_TOLERANCE &&
    Math.abs(points[0][1] - points[4][1]) <= CORNER_TOLERANCE
      ? points.slice(0, 4)
      : points;
  if (corners.length !== 4) return false;
  return corners.every((point, index) => {
    const next = corners[(index + 1) % 4];
    return (
      Math.abs(point[0] - next[0]) <= CORNER_TOLERANCE ||
      Math.abs(point[1] - next[1]) <= CORNER_TOLERANCE
    );
  });
};

const boundsOf = (points: number[][]) => {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
};

/**
 * Read the page's vector artwork straight from the operator list, in viewport
 * coordinates. This replaces rasterising the page and guessing edges from dark
 * pixels: frames, table cells and signature rules are recovered exactly, page
 * rotation included, and the whole pass runs without a canvas.
 */
export function extractVectorShapes(
  pdfjs: PdfjsModule,
  operatorList: OperatorList,
  baseTransform: number[],
): VectorShape[] {
  const { OPS, Util } = pdfjs;
  const arity: Record<number, number> = {
    [OPS.moveTo]: 2,
    [OPS.lineTo]: 2,
    [OPS.curveTo]: 6,
    [OPS.curveTo2]: 4,
    [OPS.curveTo3]: 4,
    [OPS.closePath]: 0,
    [OPS.rectangle]: 4,
  };

  const shapes: VectorShape[] = [];
  const matrixStack: number[][] = [];
  let matrix = baseTransform;
  const operators = Math.min(operatorList.fnArray.length, MAX_OPERATORS);

  const push = (points: number[][]) => {
    if (shapes.length >= MAX_SHAPES) return;
    const { left, top, width, height } = boundsOf(
      points.map(([x, y]) => applyMatrix(matrix, x, y)),
    );
    const shape = classify(left, top, width, height);
    if (shape) shapes.push(shape);
  };

  for (let index = 0; index < operators; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] as never;

    if (operator === OPS.save) {
      matrixStack.push(matrix);
    } else if (operator === OPS.restore) {
      matrix = matrixStack.pop() ?? baseTransform;
    } else if (operator === OPS.transform) {
      matrix = Util.transform(matrix, args as unknown as number[]);
    } else if (operator === OPS.paintFormXObjectBegin) {
      matrixStack.push(matrix);
      const [formMatrix] = args as unknown as number[][];
      if (Array.isArray(formMatrix))
        matrix = Util.transform(matrix, formMatrix);
    } else if (operator === OPS.paintFormXObjectEnd) {
      matrix = matrixStack.pop() ?? baseTransform;
    } else if (operator === OPS.constructPath) {
      const [pathOps, coordinates] = args as unknown as [
        ArrayLike<number>,
        ArrayLike<number>,
      ];
      if (!pathOps || !coordinates) continue;
      let cursor = 0;
      let points: number[][] = [];
      let straight = true;
      const flush = () => {
        if (straight && points.length >= 2) {
          if (points.length === 2 || isAxisAlignedQuad(points)) push(points);
        }
        points = [];
        straight = true;
      };

      for (let step = 0; step < pathOps.length; step += 1) {
        const pathOp = pathOps[step];
        if (pathOp === OPS.rectangle) {
          flush();
          const x = coordinates[cursor];
          const y = coordinates[cursor + 1];
          const width = coordinates[cursor + 2];
          const height = coordinates[cursor + 3];
          cursor += 4;
          push([
            [x, y],
            [x + width, y],
            [x + width, y + height],
            [x, y + height],
          ]);
        } else if (pathOp === OPS.moveTo) {
          flush();
          points.push([coordinates[cursor], coordinates[cursor + 1]]);
          cursor += 2;
        } else if (pathOp === OPS.lineTo) {
          points.push([coordinates[cursor], coordinates[cursor + 1]]);
          cursor += 2;
        } else if (pathOp === OPS.closePath) {
          if (points.length > 0) points.push(points[0]);
        } else {
          straight = false;
          cursor += arity[pathOp] ?? 0;
        }
      }
      flush();
    }
  }

  return shapes;
}

const overlaps = (
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
) => Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart);

/**
 * Frames stroked as four independent segments never reach `extractVectorShapes`
 * as a rectangle. Pair the rules back into the box they outline so those
 * documents behave like the ones that emit a single closed path.
 */
export function recomposeRectangles(shapes: VectorShape[]): VectorShape[] {
  const horizontal = shapes
    .filter((shape) => shape.kind === "horizontal-rule")
    .slice(0, 120);
  const vertical = shapes
    .filter((shape) => shape.kind === "vertical-rule")
    .slice(0, 120);
  const rectangles: VectorShape[] = [];

  for (let first = 0; first < horizontal.length; first += 1) {
    for (let second = first + 1; second < horizontal.length; second += 1) {
      const top =
        horizontal[first].top < horizontal[second].top
          ? horizontal[first]
          : horizontal[second];
      const bottom =
        top === horizontal[first] ? horizontal[second] : horizontal[first];
      const height = bottom.top - top.top;
      if (height < MIN_RECTANGLE_SIDE) continue;
      const left = Math.max(top.left, bottom.left);
      const right = Math.min(top.left + top.width, bottom.left + bottom.width);
      if (right - left < MIN_RECTANGLE_SIDE) continue;
      const sides = vertical.filter(
        (side) =>
          overlaps(side.top, side.top + side.height, top.top, bottom.top) >=
          height * 0.7,
      );
      const leftSide = sides.some(
        (side) => Math.abs(side.left - left) <= CORNER_TOLERANCE * 2,
      );
      const rightSide = sides.some(
        (side) => Math.abs(side.left - right) <= CORNER_TOLERANCE * 2,
      );
      if (!leftSide || !rightSide) continue;
      rectangles.push({
        left,
        top: top.top,
        width: right - left,
        height,
        kind: "rectangle",
      });
      if (rectangles.length >= 40) return rectangles;
    }
  }
  return rectangles;
}
