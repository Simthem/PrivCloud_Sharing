import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

import {
  isPrefilledSignatureLabel,
  isSignaturePlacementLabel,
  placeSignatureBesideTextAnchor,
  scoreSignatureAnchorContext,
} from "../src/utils/signaturePlacementLabel.util.ts";
import {
  chooseSignaturePlacement,
  placeSignatureInsideBox,
  placeSignatureOnRule,
} from "../src/utils/signaturePlacementLayout.util.ts";
import { detectSignaturePlacement } from "../src/utils/signaturePlacementDetection.util.ts";

const POINTS_PER_MM = 72 / 25.4;
const A4 = { width: 595, height: 842 };

const toArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Ground-truth frames are written in PDF user space; compare in millimetres. */
const visualMm = ({ x, y, width, height }, page = A4) => ({
  leftMm: x / POINTS_PER_MM,
  topMm: (page.height - y - height) / POINTS_PER_MM,
  widthMm: width / POINTS_PER_MM,
  heightMm: height / POINTS_PER_MM,
});

const assertInside = (placement, frame, label) => {
  assert.ok(placement, `${label}: nothing detected`);
  const slack = 0.2;
  assert.ok(
    placement.leftMm >= frame.leftMm - slack,
    `${label}: left ${placement.leftMm.toFixed(1)} < ${frame.leftMm.toFixed(1)}`,
  );
  assert.ok(
    placement.topMm >= frame.topMm - slack,
    `${label}: top ${placement.topMm.toFixed(1)} < ${frame.topMm.toFixed(1)}`,
  );
  assert.ok(
    placement.leftMm + placement.widthMm <=
      frame.leftMm + frame.widthMm + slack,
    `${label}: overflows the frame on the right`,
  );
  assert.ok(
    placement.topMm + placement.heightMm <=
      frame.topMm + frame.heightMm + slack,
    `${label}: overflows the frame at the bottom`,
  );
  assert.ok(
    placement.widthMm > 20 && placement.heightMm > 8,
    `${label}: too small`,
  );
};

test("recognizes common signature anchors without matching unrelated text", () => {
  for (const label of [
    "Signature",
    "Signature du client",
    "SIGNATAIRE",
    "Signed by",
    "Customer sign",
    "Unterschrift",
    "Bon pour accord",
  ]) {
    assert.equal(isSignaturePlacementLabel(label), true, label);
  }

  for (const label of ["Date", "Nom du client", "Paraphe", "Référence"]) {
    assert.equal(isSignaturePlacementLabel(label), false, label);
  }

  assert.equal(
    isPrefilledSignatureLabel("Lu et approuvé le 20 septembre 2026"),
    true,
  );
  assert.equal(isPrefilledSignatureLabel("Signature"), false);
});

test("prefers a signature label grouped with Date and Name fields", () => {
  const signature = {
    text: "Signature",
    left: 107,
    top: 90,
    width: 50,
    height: 18,
  };
  const labels = [
    { text: "Date", left: 107, top: 50, width: 30, height: 12 },
    { text: "Nom", left: 107, top: 70, width: 28, height: 12 },
  ];

  assert.equal(scoreSignatureAnchorContext(signature, labels), 2);
  assert.equal(
    scoreSignatureAnchorContext(signature, [
      { text: "Référence", left: 400, top: 10, width: 50, height: 12 },
    ]),
    0,
  );
});

test("keeps the signature inside the frame that holds the labels", () => {
  const frame = { left: 91, top: 37, width: 347, height: 113 };
  const placement = placeSignatureInsideBox(
    { left: 107, top: 90, width: 50, height: 18 },
    frame,
    [
      { left: 107, top: 50, width: 30, height: 12 },
      { left: 107, top: 70, width: 28, height: 12 },
    ],
    240,
    80,
  );

  assert.ok(placement);
  assert.ok(placement.left >= 165, "sits right of the labels");
  assert.ok(placement.left + placement.width <= frame.left + frame.width);
  assert.ok(placement.top >= frame.top);
  assert.ok(placement.top + placement.height <= frame.top + frame.height);
});

test("drops the signature under the labels when the frame has no free column", () => {
  const frame = { left: 40, top: 40, width: 150, height: 120 };
  const placement = placeSignatureInsideBox(
    { left: 50, top: 50, width: 120, height: 14 },
    frame,
    [],
    240,
    80,
  );

  assert.ok(placement);
  assert.ok(placement.top >= 64, "starts below the label");
  assert.ok(placement.left + placement.width <= frame.left + frame.width);
  assert.ok(placement.top + placement.height <= frame.top + frame.height);
});

test("sits on the ruled line that follows the anchor", () => {
  const placement = placeSignatureOnRule(
    { left: 57, top: 190, width: 48, height: 10 },
    { left: 130, top: 250, width: 290, height: 0 },
    [],
    240,
    80,
  );

  assert.ok(placement);
  assert.ok(
    Math.abs(placement.top + placement.height - 249) <= 1,
    "rests on the rule",
  );
  assert.ok(placement.left >= 130 && placement.left + placement.width <= 420);
});

test("aligns the signature field with the text anchor instead of below it", () => {
  const placement = placeSignatureBesideTextAnchor({
    left: 40,
    top: 63.2,
    width: 72,
    height: 18,
  });

  assert.equal(placement.top, 63.2);
  assert.equal(placement.left, 120);
});

test("prefers the empty counterparty frame over the one already filled in", () => {
  const issuer = {
    left: 40,
    top: 600,
    width: 230,
    height: 120,
    kind: "rectangle",
  };
  const client = {
    left: 300,
    top: 600,
    width: 230,
    height: 120,
    kind: "rectangle",
  };
  const placement = chooseSignaturePlacement({
    textItems: [
      { text: "Signature", left: 50, top: 620, width: 40, height: 9 },
      {
        text: "Lu et approuvé le 20 septembre 2026",
        left: 50,
        top: 640,
        width: 170,
        height: 9,
      },
      { text: "Thémiot Simon", left: 50, top: 660, width: 70, height: 9 },
      { text: "Signature", left: 310, top: 620, width: 40, height: 9 },
    ],
    shapes: [issuer, client],
    pageWidth: 595,
    pageHeight: 842,
    preferredWidth: 240,
    preferredHeight: 80,
  });

  assert.ok(placement);
  assert.equal(placement.strategy, "box");
  assert.ok(placement.left >= client.left, "lands in the client frame");
});

test("places the signature inside a framed Date / Nom / Signature block", async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([A4.width, A4.height]);
  const frame = { x: 196, y: 75, width: 347, height: 113 };
  page.drawRectangle({
    ...frame,
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
  });
  for (const [index, label] of ["Date", "Nom", "Signature"].entries()) {
    page.drawText(label, {
      x: 212,
      y: 160 - index * 22,
      size: 9,
      font: helvetica,
    });
  }

  const placement = await detectSignaturePlacement(
    toArrayBuffer(await doc.save()),
  );

  assert.equal(placement.page, 1);
  assert.equal(placement.strategy, "box");
  assertInside(placement, visualMm(frame), "framed block");
  assert.ok(
    placement.leftMm > frame.x / POINTS_PER_MM + 5,
    "clears the labels",
  );
});

test("uses an existing signature widget verbatim", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([A4.width, A4.height]);
  const rect = { x: 180, y: 150, width: 240, height: 60 };
  doc.getForm().createTextField("Signature1").addToPage(page, rect);

  const placement = await detectSignaturePlacement(
    toArrayBuffer(await doc.save()),
  );

  assert.equal(placement.strategy, "widget");
  assert.equal(placement.confidence, 1);
  const expected = visualMm(rect);
  assert.ok(Math.abs(placement.leftMm - expected.leftMm) < 0.5);
  assert.ok(Math.abs(placement.topMm - expected.topMm) < 0.5);
});

test("rests on the underline that follows a Signature label", async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([A4.width, A4.height]);
  page.drawText("Signature :", { x: 57, y: 200, size: 10, font: helvetica });
  page.drawLine({
    start: { x: 130, y: 150 },
    end: { x: 420, y: 150 },
    thickness: 1,
  });

  const placement = await detectSignaturePlacement(
    toArrayBuffer(await doc.save()),
  );

  assert.equal(placement.strategy, "rule");
  const ruleTopMm = (A4.height - 150) / POINTS_PER_MM;
  assert.ok(Math.abs(placement.topMm + placement.heightMm - ruleTopMm) < 1.5);
  assert.ok(placement.leftMm >= 130 / POINTS_PER_MM - 0.2);
  assert.ok(placement.leftMm + placement.widthMm <= 420 / POINTS_PER_MM + 0.2);
});

test("finds the signature block on the last page of a long document", async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const frame = { x: 300, y: 60, width: 240, height: 90 };
  for (let index = 0; index < 4; index += 1) {
    const page = doc.addPage([A4.width, A4.height]);
    for (let line = 0; line < 35; line += 1) {
      page.drawText(`Clause ${line + 1} de la page ${index + 1}.`, {
        x: 57,
        y: 780 - line * 20,
        size: 9,
        font: helvetica,
      });
    }
    if (index === 3) {
      page.drawRectangle({
        ...frame,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,
      });
      page.drawText("Signature", { x: 310, y: 130, size: 9, font: helvetica });
    }
  }

  const placement = await detectSignaturePlacement(
    toArrayBuffer(await doc.save()),
  );

  assert.equal(placement.page, 4);
  assertInside(placement, visualMm(frame), "last page");
});

test("follows the viewer's orientation on a rotated page", async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([A4.width, A4.height]);
  page.setRotation(degrees(90));
  const frame = { x: 300, y: 80, width: 240, height: 100 };
  page.drawRectangle({ ...frame, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawText("Signature", { x: 310, y: 160, size: 9, font: helvetica });

  const placement = await detectSignaturePlacement(
    toArrayBuffer(await doc.save()),
  );

  assert.ok(placement);
  // A 90° viewport swaps the axes: the frame is read at (y, x) of user space.
  const rotatedFrame = {
    leftMm: frame.y / POINTS_PER_MM,
    topMm: frame.x / POINTS_PER_MM,
    widthMm: frame.height / POINTS_PER_MM,
    heightMm: frame.width / POINTS_PER_MM,
  };
  assertInside(placement, rotatedFrame, "rotated page");
});

test("falls back to an empty frame when no signature wording exists", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([A4.width, A4.height]);
  page.drawRectangle({
    x: 57,
    y: 90,
    width: 480,
    height: 600,
    borderColor: rgb(0.85, 0.85, 0.85),
    borderWidth: 1,
  });
  const frame = { x: 320, y: 110, width: 200, height: 90 };
  page.drawRectangle({ ...frame, borderColor: rgb(0, 0, 0), borderWidth: 1 });

  const placement = await detectSignaturePlacement(
    toArrayBuffer(await doc.save()),
  );

  assert.equal(placement.strategy, "geometry");
  assertInside(placement, visualMm(frame), "empty frame");
});

test("ignores a passing mention of the word in a sentence", async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  doc
    .addPage([A4.width, A4.height])
    .drawText(
      "Le present document ne vaut pas signature electronique au sens du reglement.",
      { x: 57, y: 700, size: 10, font: helvetica },
    );

  assert.equal(
    await detectSignaturePlacement(toArrayBuffer(await doc.save())),
    null,
  );
});

test("returns null on a page that offers no usable signal", async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([A4.width, A4.height]);
  page.drawText("Note de synthèse interne, diffusion restreinte.", {
    x: 57,
    y: 700,
    size: 11,
    font: helvetica,
  });

  assert.equal(
    await detectSignaturePlacement(toArrayBuffer(await doc.save())),
    null,
  );
});
