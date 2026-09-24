import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_SIGNATURE_SLOT_POINTS,
  defaultSignatureSlotPosition,
  fitSignatureImage,
  resolveSignatureSlots,
  splitSignatureArea,
} from "../src/utils/signatureSlots.util.ts";
import { buildAutoSignatureFields } from "../src/utils/signatureAutoFields.util.ts";

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const assertNoOverlap = (rects) => {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.equal(overlaps(rects[i], rects[j]), false, `${i} overlaps ${j}`);
    }
  }
};

const options = {
  minWidth: MIN_SIGNATURE_SLOT_POINTS.width,
  minHeight: MIN_SIGNATURE_SLOT_POINTS.height,
  gap: 8,
  yAxis: "up",
};

test("splits a wide area side by side, a tall one in rows", () => {
  const wide = splitSignatureArea({ x: 0, y: 100, width: 590, height: 100 }, 3, options);
  assert.deepEqual(new Set(wide.map((rect) => rect.y)).size, 1);
  assertNoOverlap(wide);
  const tall = splitSignatureArea({ x: 50, y: 100, width: 200, height: 300 }, 3, options);
  assert.deepEqual(new Set(tall.map((rect) => rect.x)).size, 1);
  assertNoOverlap(tall);
  assert.ok(tall[0].y > tall[2].y, "first signer is on top in PDF coordinates");
});

test("grows a small area into a grid of readable blocks", () => {
  for (let count = 2; count <= 8; count += 1) {
    const rects = splitSignatureArea({ x: 0, y: 400, width: 250, height: 60 }, count, options);
    assert.equal(rects.length, count);
    assertNoOverlap(rects);
    for (const rect of rects) {
      assert.ok(rect.width >= MIN_SIGNATURE_SLOT_POINTS.width);
      assert.ok(rect.height >= MIN_SIGNATURE_SLOT_POINTS.height);
    }
  }
});

test("gives every signer its own block", () => {
  const shared = { type: "SIGNATURE", assignedRecipientId: null, page: 1, posX: 300, posY: 100, width: 240, height: 80 };
  const own = { ...shared, assignedRecipientId: "carol", posX: 40 };
  const slots = resolveSignatureSlots(["alice", "bob", "carol"], [shared, own]);
  assert.equal(slots.get("carol").field, own);
  const rects = ["alice", "bob"].map((id) => {
    const { field } = slots.get(id);
    return { x: field.posX, y: field.posY, width: field.width, height: field.height };
  });
  assertNoOverlap(rects);

  const defaults = resolveSignatureSlots(["alice", "bob", "carol"], []);
  const positions = ["alice", "bob", "carol"].map((id) => {
    const slot = defaults.get(id);
    return {
      ...defaultSignatureSlotPosition({
        index: slot.index,
        count: slot.count,
        pageWidth: 595,
        boxWidth: 240,
        boxHeight: 90,
        rightEdge: 575,
        baseY: 110,
      }),
      width: 240,
      height: 90,
    };
  });
  assertNoOverlap(positions);
});

test("keeps the historical position for a single signer", () => {
  assert.deepEqual(
    defaultSignatureSlotPosition({
      index: 0, count: 1, pageWidth: 595, boxWidth: 240, boxHeight: 90, rightEdge: 575, baseY: 110,
    }),
    { x: 335, y: 110 },
  );
});

test("fits a signature image without distorting it", () => {
  const fitted = fitSignatureImage({ width: 400, height: 100 }, { width: 180, height: 40 });
  assert.equal(fitted.width / fitted.height, 4);
  assert.ok(fitted.width <= 180 && fitted.height <= 40);
});

test("suggests one block per signer inside the page", () => {
  const fields = buildAutoSignatureFields(
    { leftMm: 110, topMm: 250, widthMm: 85, heightMm: 28 },
    ["a@x.test", "b@x.test", "c@x.test", "d@x.test"],
    { widthMm: 210, heightMm: 297 },
  );
  assert.deepEqual(fields.map((field) => field.recipientEmail), ["a@x.test", "b@x.test", "c@x.test", "d@x.test"]);
  assertNoOverlap(fields.map((field) => ({ x: field.leftMm, y: field.topMm, width: field.widthMm, height: field.heightMm })));
  for (const field of fields) {
    assert.ok(field.topMm + field.heightMm <= 297.05);
    assert.ok(field.leftMm + field.widthMm <= 210.05);
  }
});
