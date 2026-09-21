import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PDF_PAGE,
  clampFieldToPage,
  fieldFitsPage,
  fieldMillimetersToPdfPoints,
  getPlacementInMillimeters,
  millimetersToPoints,
  pageSizeMillimeters,
  pointsToMillimeters,
  rawPdfBoxToVisual,
  visualPdfPointToRaw,
} from "../src/utils/pdfPlacement.util.ts";

const a4 = { ...DEFAULT_PDF_PAGE, rotation: 0 };

test("converts physical millimetres to PDF points without exposing raw coordinates", () => {
  assert.ok(Math.abs(millimetersToPoints(25.4) - 72) < 0.0001);
  assert.equal(pointsToMillimeters(72), 25.4);
  assert.deepEqual(pageSizeMillimeters(a4), {
    widthMm: 209.9,
    heightMm: 297,
  });
});

test("places a field from the visual top-left on the PDF bottom-left origin", () => {
  const converted = fieldMillimetersToPdfPoints(
    { leftMm: 25, topMm: 40, widthMm: 70, heightMm: 25 },
    a4,
  );
  assert.ok(Math.abs(converted.posX - millimetersToPoints(25)) < 0.0001);
  assert.ok(
    Math.abs(
      converted.posY -
        (a4.heightPoints - millimetersToPoints(40) - millimetersToPoints(25)),
    ) < 0.0001,
  );
});

test("uses the actual page dimensions for presets and keeps fields in bounds", () => {
  const landscape = { widthPoints: 842, heightPoints: 595, rotation: 0 };
  const placement = getPlacementInMillimeters("bottom-right", landscape, {
    widthMm: 70,
    heightMm: 25,
  });
  const safe = clampFieldToPage(
    { ...placement, widthMm: 70, heightMm: 25 },
    landscape,
  );
  assert.equal(fieldFitsPage(safe, landscape), true);
  assert.ok(safe.leftMm > 200 - 70);
  assert.ok(safe.topMm > 100);

  const clamped = clampFieldToPage(
    { leftMm: 999, topMm: 999, widthMm: 70, heightMm: 25 },
    landscape,
  );
  assert.equal(fieldFitsPage(clamped, landscape), true);
});

test("maps visual placement through every PDF page rotation", () => {
  const field = { leftMm: 10, topMm: 20, widthMm: 30, heightMm: 40 };
  const width = millimetersToPoints(30);
  const height = millimetersToPoints(40);
  const left = millimetersToPoints(10);
  const top = millimetersToPoints(20);

  assert.deepEqual(pageSizeMillimeters({ ...DEFAULT_PDF_PAGE, rotation: 90 }), {
    widthMm: 297,
    heightMm: 209.9,
  });
  assert.deepEqual(
    fieldMillimetersToPdfPoints(field, { ...DEFAULT_PDF_PAGE, rotation: 90 }),
    { posX: top, posY: left, width: height, height: width },
  );
  assert.deepEqual(
    fieldMillimetersToPdfPoints(field, { ...DEFAULT_PDF_PAGE, rotation: 180 }),
    {
      posX: DEFAULT_PDF_PAGE.widthPoints - left - width,
      posY: top,
      width,
      height,
    },
  );
  assert.deepEqual(
    fieldMillimetersToPdfPoints(field, { ...DEFAULT_PDF_PAGE, rotation: 270 }),
    {
      posX: DEFAULT_PDF_PAGE.widthPoints - top - height,
      posY: DEFAULT_PDF_PAGE.heightPoints - left - width,
      width: height,
      height: width,
    },
  );
});

test("maps rotated drawing boxes back to the viewer coordinate system", () => {
  const page = { widthPoints: 600, heightPoints: 800, rotation: 90 };
  assert.deepEqual(
    rawPdfBoxToVisual({ x: 20, y: 10, width: 40, height: 100 }, page),
    { x: 10, y: 540, width: 100, height: 40 },
  );
  assert.deepEqual(visualPdfPointToRaw({ x: 10, y: 540 }, page), {
    x: 60,
    y: 10,
  });
});
