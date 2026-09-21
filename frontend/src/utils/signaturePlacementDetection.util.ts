import {
  DEFAULT_SIGNATURE_FIELD_MM,
  type PdfFieldMillimeters,
} from "./pdfPlacement.util";
import {
  extractVectorShapes,
  recomposeRectangles,
  type VectorShape,
} from "./pdfVectorGeometry.util";
import { isSignaturePlacementLabel } from "./signaturePlacementLabel.util";
import {
  chooseSignaturePlacement,
  type PlacementCandidate,
  type PlacementTextItem,
} from "./signaturePlacementLayout.util";

export { isSignaturePlacementLabel } from "./signaturePlacementLabel.util";

export type DetectedSignaturePlacement = PdfFieldMillimeters & {
  page: number;
  /** Kept as the coarse pair the request modal renders a message for. */
  source: "text" | "box";
  strategy: PlacementCandidate["strategy"] | "widget";
  confidence: number;
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
};

const POINTS_PER_MM = 72 / 25.4;
const MAX_PAGES = 30;
/** Good enough to stop looking at earlier pages. */
const CONFIDENT_ENOUGH = 0.75;

const toMillimeters = (
  box: { left: number; top: number; width: number; height: number },
  page: number,
  strategy: DetectedSignaturePlacement["strategy"],
  confidence: number,
): DetectedSignaturePlacement => ({
  page,
  // "box" is the wording that asks the requester to check the suggestion, so
  // only the two guesses that are not anchored on a label use it.
  source: strategy === "anchor" || strategy === "geometry" ? "box" : "text",
  strategy,
  confidence,
  leftMm: box.left / POINTS_PER_MM,
  topMm: box.top / POINTS_PER_MM,
  widthMm: box.width / POINTS_PER_MM,
  heightMm: box.height / POINTS_PER_MM,
});

/**
 * Text runs are laid out along the transform's own axes, so a rotated page or a
 * vertical label produces a rotated run. Build the run's four corners and take
 * their bounds instead of assuming the text is horizontal.
 */
const textItemBox = (
  pdfjs: typeof import("pdfjs-dist"),
  item: PdfTextItem,
  viewportTransform: number[],
): PlacementTextItem | null => {
  const transform = pdfjs.Util.transform(viewportTransform, item.transform);
  const angle = Math.atan2(transform[1], transform[0]);
  const height = Math.max(4, Math.hypot(transform[2], transform[3]));
  const width = Math.max(2, Number(item.width) || height * 0.5);
  const originX = transform[4];
  const originY = transform[5];
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) return null;

  const advanceX = Math.cos(angle) * width;
  const advanceY = Math.sin(angle) * width;
  const upX = Math.sin(angle) * height;
  const upY = -Math.cos(angle) * height;
  const xs = [
    originX,
    originX + advanceX,
    originX + advanceX + upX,
    originX + upX,
  ];
  const ys = [
    originY,
    originY + advanceY,
    originY + advanceY + upY,
    originY + upY,
  ];

  return {
    text: String(item.str),
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

const widgetPlacement = (
  annotations: unknown[],
  viewport: { convertToViewportRectangle: (_rect: number[]) => number[] },
) => {
  for (const annotation of annotations) {
    if (
      typeof annotation !== "object" ||
      annotation === null ||
      !("rect" in annotation)
    ) {
      continue;
    }
    const candidate = annotation as {
      rect?: unknown;
      fieldName?: unknown;
      alternativeText?: unknown;
      fieldType?: unknown;
      hidden?: unknown;
    };
    if (candidate.hidden === true) continue;
    const label = [candidate.fieldName, candidate.alternativeText]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const isSignatureWidget =
      candidate.fieldType === "Sig" || isSignaturePlacementLabel(label);
    if (
      !isSignatureWidget ||
      !Array.isArray(candidate.rect) ||
      candidate.rect.length !== 4 ||
      !candidate.rect.every((value) => Number.isFinite(value))
    ) {
      continue;
    }
    const [firstX, firstY, secondX, secondY] =
      viewport.convertToViewportRectangle(candidate.rect as number[]);
    const box = {
      left: Math.min(firstX, secondX),
      top: Math.min(firstY, secondY),
      width: Math.abs(secondX - firstX),
      height: Math.abs(secondY - firstY),
    };
    if (box.width >= 24 && box.height >= 12) return box;
  }
  return null;
};

/**
 * Suggest where the signature belongs in an arbitrary PDF, in millimetres from
 * the visual top-left corner of the page, so the requester only has to confirm.
 *
 * The page is read, never rasterised: an existing signature widget wins, then
 * the frame or rule that surrounds a signature label, then a plainly empty
 * frame low on the page. Returning null leaves the caller's own default in
 * place rather than guessing.
 */
export async function detectSignaturePlacement(
  pdfBytes: ArrayBuffer,
): Promise<DetectedSignaturePlacement | null> {
  const pdfjs = await import("pdfjs-dist");
  // The page is parsed, never rendered, so no canvas and no DOM are involved.
  // Only the browser needs to be pointed at the bundled worker.
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  }
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes.slice(0)),
  }).promise;

  const preferredWidth = DEFAULT_SIGNATURE_FIELD_MM.width * POINTS_PER_MM;
  const preferredHeight = DEFAULT_SIGNATURE_FIELD_MM.height * POINTS_PER_MM;
  let best: DetectedSignaturePlacement | null = null;

  try {
    const firstPage = Math.max(1, pdf.numPages - MAX_PAGES + 1);
    for (
      let pageNumber = pdf.numPages;
      pageNumber >= firstPage;
      pageNumber -= 1
    ) {
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });

        const widget = widgetPlacement(
          (await page.getAnnotations({ intent: "display" })) as unknown[],
          viewport,
        );
        if (widget) return toMillimeters(widget, pageNumber, "widget", 1);

        const content = await page.getTextContent();
        const textItems = (content.items as unknown[])
          .filter(
            (item): item is PdfTextItem =>
              typeof item === "object" &&
              item !== null &&
              "str" in item &&
              "transform" in item &&
              String((item as PdfTextItem).str).trim().length > 0,
          )
          .map((item) => textItemBox(pdfjs, item, viewport.transform))
          .filter((item): item is PlacementTextItem => item !== null);

        const shapes: VectorShape[] = extractVectorShapes(
          pdfjs,
          await page.getOperatorList(),
          viewport.transform,
        );
        const allShapes = shapes.concat(recomposeRectangles(shapes));

        const candidate = chooseSignaturePlacement({
          textItems,
          shapes: allShapes,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          preferredWidth,
          preferredHeight,
        });
        if (!candidate) continue;

        const detected = toMillimeters(
          candidate,
          pageNumber,
          candidate.strategy,
          candidate.confidence,
        );
        if (!best || detected.confidence > best.confidence) best = detected;
        if (detected.confidence >= CONFIDENT_ENOUGH) return detected;
      } finally {
        page.cleanup();
      }
    }
    return best;
  } finally {
    await pdf.destroy();
  }
}
