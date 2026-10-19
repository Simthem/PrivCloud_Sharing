import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import XLSX from "xlsx";
import {
  parseLegacyWorkbook,
  legacySheetValues,
} from "../src/utils/legacySpreadsheetParser.util.ts";
import {
  isLegacySheetReply,
  openLegacySpreadsheet,
} from "../src/utils/legacySpreadsheetPreview.util.ts";
import {
  doesFileSupportPreview,
  resolveFileMimeType,
  isOfficePreviewMimeType,
} from "../src/utils/filePreview.util.ts";
const workbook = () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Value"],
    ["<img src=x onerror=alert(1)>", 0.375],
    ["Amount", 1234.5],
    ["Formula", 7],
  ]);
  sheet.B3.z = "0.00";
  sheet.B2.z = "0.00%";
  sheet.B4.f = "1+2";
  XLSX.utils.book_append_sheet(book, sheet, "Budget");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([["Second sheet"]]),
    "Détails",
  );
  return book;
};
for (const bookType of [
  "biff2",
  "biff3",
  "biff4",
  "biff8",
  "biff5",
  "xlsb",
  "sylk",
  "dif",
  "wk1",
  "dbf",
])
  test(`${bookType} reads real saved values without evaluating formulas or generating HTML`, () => {
    const bytes = new Uint8Array(
      XLSX.write(workbook(), { bookType, type: "array" }),
    );
    const parsed = parseLegacyWorkbook(bytes);
    const page = legacySheetValues(parsed, 0);
    assert.match(page.rows[1][0], /<img src=x onerror=alert\(1\)>/);
    assert.equal(Number(page.rows[2][1].replace(/,/g, "")), 1234.5);
    assert.equal(Number.parseFloat(page.rows[3][1]), 7);
    assert.ok(
      page.rows.every((row) => row.every((cell) => typeof cell === "string")),
    );
    if (["biff8", "biff5", "xlsb"].includes(bookType)) {
      assert.equal(legacySheetValues(parsed, 1).rows[0][0], "Second sheet");
      assert.equal(page.rows[1][1], "37.50%");
    }
  });
test("incomplete BIFF worksheets fail at opening instead of returning a missing sheet", () => {
  const bytes = new Uint8Array(
    XLSX.write(workbook(), { bookType: "biff2", type: "array" }),
  );
  assert.deepEqual(Array.from(bytes.slice(-4)), [0x0a, 0, 0, 0]);
  assert.throws(
    () => parseLegacyWorkbook(bytes.slice(0, -4)),
    /incomplete worksheet/,
  );
  assert.throws(
    () => legacySheetValues({ SheetNames: ["Sheet1"], Sheets: {} }, 0),
    /incomplete worksheet/,
  );
});
test("SheetJS rejects a threaded-comment prototype pollution reference", () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["safe"]]);
  sheet.A1.c = [{ a: "author", t: "comment", T: true }];
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");

  const archive = unzipSync(
    new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "array" })),
  );
  const commentPath = "xl/threadedComments/threadedComment1.xml";
  const commentXml = strFromU8(archive[commentPath]);
  assert.match(commentXml, /ref="A1"/);
  archive[commentPath] = strToU8(
    commentXml.replace('ref="A1"', 'ref="__proto__"'),
  );

  assert.equal(Object.hasOwn(Object.prototype, "c"), false);
  parseLegacyWorkbook(zipSync(archive));
  const polluted = Object.hasOwn(Object.prototype, "c");
  if (polluted) delete Object.prototype.c;
  assert.equal(polluted, false);
});
test("SheetJS handles repeated XML comment openings within a fixed budget", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import XLSX from "xlsx"; try { XLSX.read(("<!--").repeat(100_000), { type: "string" }); } catch {}',
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.notEqual(child.error?.code, "ETIMEDOUT");
  assert.equal(child.status, 0, child.stderr);
});
test("rendering and worker messages have row, column and text budgets", () => {
  const book = workbook();
  book.Sheets.Budget["!ref"] = "A1:XFD1048576";
  const sheet = legacySheetValues(book, 0);
  assert.equal(sheet.rows.length, 500);
  assert.equal(sheet.rows[0].length, 100);
  assert.equal(sheet.truncated, true);
  assert.throws(() => legacySheetValues(book, -1), /index/);
  assert.throws(
    () => parseLegacyWorkbook(new Uint8Array(33 * 1024 * 1024)),
    /budget/,
  );
  assert.equal(isLegacySheetReply({ id: 1, type: "sheet", ...sheet }), true);
  for (const data of [
    { id: 1, type: "sheet", rows: [[{}]], truncated: false },
    { id: 1, type: "sheet", rows: [["x".repeat(20_000)]], truncated: false },
    { id: 1, type: "sheet", rows: [], truncated: false, html: "<img>" },
  ])
    assert.equal(isLegacySheetReply(data), false);
});
test("oversized and cancelled input fails before creating a worker", async () => {
  await assert.rejects(
    openLegacySpreadsheet(
      { size: 17 * 1024 * 1024 },
      new AbortController().signal,
    ),
    /budget/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(openLegacySpreadsheet({ size: 1 }, aborted.signal), {
    name: "AbortError",
  });
});
test("legacy extensions route to spreadsheet previews, including DIF rather than a video MIME", () => {
  for (const extension of [
    "xls",
    "xlt",
    "xlsb",
    "slk",
    "sylk",
    "dif",
    "wk1",
    "wk3",
    "wk4",
    "wks",
    "dbf",
  ]) {
    assert.equal(
      doesFileSupportPreview(`Report.${extension.toUpperCase()}`),
      true,
    );
    assert.equal(
      isOfficePreviewMimeType(resolveFileMimeType(`Report.${extension}`)),
      true,
    );
  }
  assert.equal(doesFileSupportPreview("archive.exe"), false);
});
