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
