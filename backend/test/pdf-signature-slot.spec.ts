import assert from "node:assert/strict";
import {
  findAppliedSignature,
  findSignaturePlaceholder,
} from "src/signing/pdf-signing.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("PDF signature slot");

const nulls = "\x00".repeat(1200);
const slot = `/ByteRange [0 /********** /********** /**********] /Contents <${nulls}>`;

testCase("the slot is found only when it is unique", () => {
  const pdf = `%PDF-1.7\n1 0 obj\n<< /Type /Sig ${slot} >>\nendobj\n%%EOF`;
  const found = findSignaturePlaceholder(pdf);
  assert.equal(pdf[found.contentsOpen], "<");
  assert.equal(pdf[found.contentsClose], ">");
  // A source stream carrying a look-alike makes the PDF refused.
  const decoy = `%PDF-1.7\nstream\n${slot}\nendstream\n1 0 obj\n<< ${slot} >>\nendobj`;
  assert.throws(() => findSignaturePlaceholder(decoy), /exactly one/);
  assert.throws(
    () => findSignaturePlaceholder(`%PDF /Contents <${nulls}>`),
    /exactly one/,
  );
});

testCase(
  "the applied signature is the one reaching the end of the file",
  () => {
    const earlier = "/ByteRange [0 10 20 5] /Contents <abcd>";
    const head = `%PDF-1.7\n${earlier}\n<< /ByteRange [0 `;
    // Offsets are solved for the final layout below.
    const hex = "00ff".repeat(4);
    const build = (open: number, after: number, rest: number) =>
      `${head}${open} ${after} ${rest}] /Contents <${hex}> >>\n%%EOF`;
    let pdf = build(0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const open = pdf.indexOf(`<${hex}>`);
      const after = open + hex.length + 2;
      pdf = build(open, after, pdf.length - after);
    }
    const applied = findAppliedSignature(pdf);
    assert.equal(applied.hexSignature, hex);
    assert.equal(pdf[applied.contentsStart - 1], "<");
  },
);

void run();
