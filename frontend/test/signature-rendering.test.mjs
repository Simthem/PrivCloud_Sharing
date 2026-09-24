import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfSafeText } from "../src/utils/pdfText.util.ts";
import { parseSignatureData } from "../src/utils/signatureData.util.ts";

test("never hands the standard fonts a character they cannot encode", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage();
  for (const [input, expected] of [
    ["Élodie Müller", "Élodie Müller"],
    ["Łukasz Wiśniewski", "Lukasz Wisniewski"],
    ["王伟", "??"],
    ["Zoë 😀", "Zoë ?"],
    ["ligne\nsuivante", "ligne suivante"],
  ]) {
    const safe = pdfSafeText(input, font);
    assert.equal(safe, expected);
    page.drawText(safe, { font });
  }
});

test("takes the signature format from the bytes", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(parseSignatureData(png, "TYPE").format, "png");
  assert.equal(parseSignatureData(jpeg, "UPLOAD").format, "jpg");
  assert.throws(() => parseSignatureData("data:image/webp;base64,UklGRg==", "UPLOAD"));
  assert.deepEqual(parseSignatureData("  Zoë Dupont ", "TYPE"), { kind: "text", text: "Zoë Dupont" });
  assert.throws(() => parseSignatureData("Zoë Dupont", "DRAW"));
  assert.throws(() => parseSignatureData("x".repeat(121), "TYPE"));
});
