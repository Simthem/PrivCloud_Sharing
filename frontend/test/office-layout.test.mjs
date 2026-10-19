import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import fixtures from "./fixtures/office-documents.cjs";
import { openOfficeDocument } from "../src/utils/officeDocumentPreview.util.ts";
import {
  officeImageMime,
  parseOfficeXml,
  resolveOfficePart,
} from "../src/utils/officePreviewModel.util.ts";
import {
  formatSpreadsheetNumber,
  parseDelimitedSheet,
} from "../src/utils/spreadsheetPreview.util.ts";
import { parseRtfPreview } from "../src/utils/rtfPreview.util.ts";
import { odfStyles } from "../src/utils/officePreviewStyles.util.ts";
import {
  doesFileSupportPreview,
  isOfficePreviewMimeType,
} from "../src/utils/filePreview.util.ts";
const parser = new new JSDOM("").window.DOMParser();
const source = (bytes, reads = []) => ({
  size: bytes.length,
  read: async (start, end, signal) => {
    signal?.throwIfAborted();
    reads.push([start, end]);
    return bytes.slice(start, end);
  },
});
const open = (entries, mime = "", padding = 0, reads = []) =>
  openOfficeDocument(
    source(fixtures.officePackage(entries, padding), reads),
    new AbortController().signal,
    mime,
    parser,
    "en-US",
  );
const cellText = (cell) => cell.runs.map((r) => r.text).join("");
test("DOCX restores heading, runs, shaded merged table, page margins and local image", async () => {
  const doc = await open(fixtures.docx);
  const page = await doc.load(0);
  assert.equal(doc.kind, "document");
  assert.ok(page.width > 790);
  assert.equal(page.padding[0], 48);
  assert.equal(page.blocks[0].heading, 1);
  assert.equal(page.blocks[0].style.textAlign, "center");
  assert.equal(page.blocks[0].runs[0].style.color, "#2255AA");
  assert.equal(page.blocks[1].runs[0].style.fontWeight, 700);
  assert.equal(page.blocks[1].runs[0].style.color, "#AA2244");
  assert.equal(page.blocks[1].runs[1].text, " and safe <script> text");
  const table = page.blocks.find((b) => b.kind === "table");
  assert.equal(table.rows[0].cells[0].colSpan, 2);
  assert.equal(table.rows[0].cells[0].style.backgroundColor, "#DDEEFF");
  const image = page.blocks.find((b) => b.kind === "image");
  assert.equal(image.path, "word/media/pixel.png");
  assert.equal(officeImageMime(await doc.image(image.path)), "image/png");
  assert.equal(await doc.image("https://example.invalid/tracker.png"), null);
});
test("ODT and flat ODF keep heading, span and table formatting", async () => {
  for (const mime of ["", "application/vnd.oasis.opendocument.text-flat-xml"]) {
    const doc = mime
      ? await openOfficeDocument(
          source(new TextEncoder().encode(fixtures.odtXml)),
          new AbortController().signal,
          mime,
          parser,
        )
      : await open({
          "content.xml": fixtures.odtXml,
          "Pictures/pixel.png": fixtures.png,
        });
    const page = await doc.load(0);
    assert.equal(page.blocks[0].style.textAlign, "center");
    assert.equal(page.blocks[0].runs[0].style.fontSize, 32);
    const emphasis = page.blocks[1].runs.find(
      (r) => r.text === "with formatting",
    );
    assert.equal(emphasis.style.fontStyle, "italic");
    assert.equal(emphasis.style.color, "#aa2244");
    assert.equal(
      page.blocks.find((b) => b.kind === "table").rows[0].cells[0].style
        .backgroundColor,
      "#ddeeff",
    );
  }
});
test("XLSX styles, merged cells, rich strings and cached formulas survive sheet navigation", async () => {
  const doc = await open(fixtures.xlsx);
  assert.equal(doc.kind, "workbook");
  assert.deepEqual(
    doc.units.map((s) => s.name),
    ["Budget", "Détails"],
  );
  const page = await doc.load(0);
  const table = page.blocks[0];
  assert.equal(table.rows[0].cells[0].colSpan, 2);
  assert.equal(table.rows[0].cells[1].covered, true);
  assert.equal(table.rows[0].cells[0].style.backgroundColor, "#2255AA");
  assert.equal(table.rows[0].cells[0].style.fontWeight, 700);
  assert.equal(table.rows[0].height, (32 * 4) / 3);
  assert.equal(table.widths[0], 26 * 7 + 5);
  assert.equal(table.rows[1].cells[0].runs[0].style.color, "#AA2244");
  assert.equal(cellText(table.rows[2].cells[1]), "37.50%");
  assert.equal(cellText(table.rows[3].cells[1]), "1234.875");
  assert.equal(table.rows[3].cells[1].formula, "SUM(B2:B3)");
  assert.equal(cellText(table.rows[4].cells[1]), "01/01/2024");
  const second = await doc.load(1);
  assert.equal(cellText(second.blocks[0].rows[0].cells[0]), "Second sheet");
  assert.match(cellText(second.blocks[0].rows[0].cells[1]), /<img src=x/);
  await assert.rejects(doc.load(2), /index/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(doc.load(0, aborted.signal), { name: "AbortError" });
});
test("XLSX reads selected XML parts without fetching unrelated package padding", async () => {
  const reads = [];
  const doc = await open(fixtures.xlsx, "", 12 * 1024 * 1024, reads);
  await doc.load(0);
  const count = reads.reduce((sum, [a, b]) => sum + b - a, 0);
  assert.ok(count < 512 * 1024, `read ${count} bytes`);
  await doc.load(1);
  assert.ok(reads.reduce((sum, [a, b]) => sum + b - a, 0) < 1024 * 1024);
});
test("PPTX preserves slide geometry, background, styled runs and layout inheritance", async () => {
  const doc = await open(fixtures.pptx);
  const page = await doc.load(0);
  assert.equal(doc.kind, "presentation");
  assert.equal(doc.units.length, 2);
  assert.equal(page.width, 960);
  assert.equal(page.height, 540);
  assert.equal(page.background, "#F7FAFF");
  assert.equal(page.shapes[0].x, 96);
  assert.equal(page.shapes[0].y, 48);
  assert.equal(page.shapes[0].style.backgroundColor, "#DDEEFF");
  assert.equal(page.shapes[0].blocks[0].runs[0].style.fontWeight, 700);
  assert.equal(page.shapes[1].y, 240);
  assert.equal(page.shapes[1].blocks[0].runs[0].style.fontSize, 32);
  assert.equal(
    officeImageMime(await doc.image(page.shapes[2].blocks[0].path)),
    "image/png",
  );
  const next = await doc.load(1);
  assert.equal(next.shapes[0].blocks[0].runs[0].text, "Second slide");
});
test("CSV quoted delimiters, multiline values and formulas remain inert table text", () => {
  const page = parseDelimitedSheet(
    'name,value\r\n"a,b","line1\nline2"\r\n=HYPERLINK("https://example.invalid"),42',
    ",",
    false,
  );
  assert.equal(cellText(page.blocks[0].rows[1].cells[0]), "a,b");
  assert.equal(cellText(page.blocks[0].rows[1].cells[1]), "line1\nline2");
  assert.match(cellText(page.blocks[0].rows[2].cells[0]), /^=HYPERLINK/);
});
test("RTF styles, Unicode and skipped executable/hidden destinations are bounded", () => {
  const page = parseRtfPreview(
    "{\\rtf1\\ansi{\\colortbl;\\red170\\green34\\blue68;}\\qc\\b\\cf1 Title\\b0\\par Text \\u233?{\\*\\fldinst HYPERLINK secret}{\\object hidden}\\par}",
  );
  assert.equal(page.blocks[0].style.textAlign, "center");
  assert.equal(page.blocks[0].runs[0].style.fontWeight, 700);
  assert.equal(page.blocks[0].runs[0].style.color, "#aa2244");
  assert.equal(page.blocks[1].runs.map((r) => r.text).join(""), "Text é");
  assert.equal(JSON.stringify(page).includes("secret"), false);
  assert.equal(
    parseRtfPreview("{\\rtf1 " + "\\b a\\b0 b".repeat(5000) + "}").truncated,
    true,
  );
});
test("Office XML, relationships and image dimensions reject active or excessive input", () => {
  assert.throws(
    () => parseOfficeXml('<!DOCTYPE a [<!ENTITY b "x">]><a/>', parser),
    /entities/,
  );
  assert.throws(
    () => parseOfficeXml("<a>".repeat(66) + "</a>".repeat(66), parser),
    /nesting/,
  );
  assert.throws(() => parseOfficeXml("<a>", parser), /Invalid/);
  for (const path of [
    "../../secret",
    "https://example.invalid/x",
    "//example.invalid/x",
    "javascript:alert(1)",
    "bad\\path",
  ])
    assert.equal(resolveOfficePart("word/document.xml", path), null);
  assert.equal(
    resolveOfficePart("ppt/slides/slide1.xml", "../media/pixel.png"),
    "ppt/media/pixel.png",
  );
  assert.equal(
    officeImageMime(new Uint8Array([255, 216, 255, 255, 255, 255, 255, 255])),
    null,
  );
  const huge = fixtures.png.slice();
  new DataView(huge.buffer).setUint32(16, 100000);
  assert.equal(officeImageMime(huge), null);
  assert.equal(
    officeImageMime(new TextEncoder().encode('<svg onload="alert(1)"/>')),
    null,
  );
});
test("expanded modern Office, templates and flat ODF MIME types are eligible without file-size cutoffs", () => {
  for (const name of [
    "file.xlsx",
    "file.xlsm",
    "file.xltx",
    "file.xltm",
    "file.docx",
    "file.docm",
    "file.dotx",
    "file.dotm",
    "file.pptx",
    "file.pptm",
    "file.potx",
    "file.potm",
    "file.ppsx",
    "file.ppsm",
    "file.odt",
    "file.ods",
    "file.odp",
    "file.fodt",
    "file.fods",
    "file.fodp",
    "file.csv",
    "file.tsv",
    "file.rtf",
  ])
    assert.equal(
      doesFileSupportPreview(name, {
        fileSizeBytes: 40_000_000_000,
        isE2EEncrypted: true,
      }),
      true,
      name,
    );
  assert.equal(
    isOfficePreviewMimeType(
      "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    ),
    true,
  );
  assert.equal(
    formatSpreadsheetNumber("0.125", "0.0%", false, "fr-FR"),
    "12,5\u00a0%",
  );
});

test("ODS and flat ODF spreadsheets preserve sheets, repeats, shading and covered cells", async () => {
  const body = `<office:body><office:spreadsheet><table:table table:name="First"><table:table-row><table:table-cell table:style-name="Cell" table:number-columns-spanned="2"><text:p>ODF budget</text:p></table:table-cell><table:covered-table-cell/></table:table-row><table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="float" office:value="42"/></table:table-row></table:table><table:table table:name="Second"><table:table-row><table:table-cell><text:p>Next ODF sheet</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body>`;
  const xml = fixtures.odtXml.replace(
    /<office:body>[\s\S]*<\/office:body>/,
    body,
  );
  for (const flat of [false, true]) {
    const doc = flat
      ? await openOfficeDocument(
          source(new TextEncoder().encode(xml)),
          new AbortController().signal,
          "application/vnd.oasis.opendocument.spreadsheet-flat-xml",
          parser,
        )
      : await open({ "content.xml": xml });
    assert.equal(doc.kind, "workbook");
    assert.equal(doc.units.length, 2);
    const table = (await doc.load(0)).blocks[0];
    assert.equal(table.rows[0].cells[0].style.backgroundColor, "#ddeeff");
    assert.equal(table.rows[0].cells[0].colSpan, 2);
    assert.equal(table.rows[0].cells[1].covered, true);
    assert.equal(table.rows.length, 3);
    assert.equal(cellText(table.rows[2].cells[0]), "42");
    assert.equal(
      cellText((await doc.load(1)).blocks[0].rows[0].cells[0]),
      "Next ODF sheet",
    );
  }
});
test("ODP and flat ODF presentations preserve positions and slide navigation", async () => {
  const body = `<office:body><office:presentation><draw:page draw:name="Start"><draw:frame svg:x="2.54cm" svg:y="1.27cm" svg:width="15cm" svg:height="3cm"><draw:text-box><text:p text:style-name="Title">ODF slide</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="End"><draw:frame svg:width="15cm" svg:height="3cm"><draw:text-box><text:p>Next ODF slide</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body>`;
  const xml = fixtures.odtXml.replace(
    /<office:body>[\s\S]*<\/office:body>/,
    body,
  );
  for (const flat of [false, true]) {
    const doc = flat
      ? await openOfficeDocument(
          source(new TextEncoder().encode(xml)),
          new AbortController().signal,
          "application/vnd.oasis.opendocument.presentation-flat-xml",
          parser,
        )
      : await open({ "content.xml": xml });
    assert.equal(doc.kind, "presentation");
    assert.equal(doc.units.length, 2);
    const shape = (await doc.load(0)).shapes[0];
    assert.equal(shape.x, 96);
    assert.equal(shape.y, 48);
    assert.equal(shape.blocks[0].runs[0].style.color, "#2255aa");
    assert.equal(
      (await doc.load(1)).shapes[0].blocks[0].runs[0].text,
      "Next ODF slide",
    );
  }
});
test("ODF styles exclude resource URLs and inheritance cycles remain bounded", () => {
  const xml = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"><style:style style:name="A" style:family="text" style:parent-style-name="B"><style:text-properties fo:font-family="url(https://example.invalid)" fo:color="url(https://example.invalid)" fo:background-color="expression(alert(1))"/></style:style><style:style style:name="B" style:family="text" style:parent-style-name="A"/></office:document-content>`;
  const styles = odfStyles([parseOfficeXml(xml, parser)]);
  assert.deepEqual(styles.resolve("text", "A").text, {});
});
test("overlapping Excel merge ranges cannot multiply unbounded rendering work", async () => {
  const entries = {
    ...fixtures.xlsx,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${fixtures.ns.sheet}"><sheetData>${Array.from({ length: 100 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>1</v></c></row>`).join("")}</sheetData><mergeCells>${'<mergeCell ref="A1:CV100"/>'.repeat(1000)}</mergeCells></worksheet>`,
  };
  const page = await (await open(entries)).load(0);
  assert.equal(page.truncated, true);
  assert.ok(page.blocks[0].rows.length <= 500);
});

test("embedded-image fanout is bounded before React rendering", async () => {
  const repeated = fixtures.odtXml.replace(
    '<draw:image xlink:href="Pictures/pixel.png"/>',
    '<draw:image xlink:href="Pictures/pixel.png"/>'.repeat(1000),
  );
  const doc = await open({
    "content.xml": repeated,
    "Pictures/pixel.png": fixtures.png,
  });
  const page = await doc.load(0);
  assert.equal(page.blocks.filter((b) => b.kind === "image").length, 64);
  assert.equal(page.truncated, true);
});
