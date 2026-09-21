import assert from "node:assert/strict";
import {
  rawPdfBoxToVisual,
  visualPageSize,
  visualPdfPointToRaw,
} from "src/signing/pdf-rotation.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("PDF rotation geometry");
const page = { width: 600, height: 800, rotation: 90 };

testCase("restores a form box to viewer coordinates on rotated pages", () => {
  assert.deepEqual(visualPageSize(page), { width: 800, height: 600 });
  assert.deepEqual(
    rawPdfBoxToVisual({ x: 20, y: 10, width: 40, height: 100 }, page),
    { x: 10, y: 540, width: 100, height: 40 },
  );
});

testCase("maps visual drawing anchors to unrotated PDF user space", () => {
  assert.deepEqual(visualPdfPointToRaw({ x: 10, y: 540 }, page), {
    x: 60,
    y: 10,
  });
});

void run();
