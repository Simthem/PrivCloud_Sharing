import { read, utils, type WorkBook } from "xlsx";

export const LEGACY_SPREADSHEET_MAX_BYTES = 16 * 1024 * 1024;
export const LEGACY_SPREADSHEET_MAX_ROWS = 500;
export const LEGACY_SPREADSHEET_MAX_COLUMNS = 100;
export type LegacySheet = { rows: string[][]; truncated: boolean };

/** Read saved values only. Never generate HTML, evaluate formulas or load VBA. */
export function parseLegacyWorkbook(bytes: Uint8Array): WorkBook {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024)
    throw new Error("Spreadsheet exceeds preview budget");
  const workbook = read(bytes, {
    type: "array",
    dense: true,
    sheetRows: LEGACY_SPREADSHEET_MAX_ROWS + 1,
    cellHTML: false,
    cellFormula: false,
    cellStyles: false,
    bookVBA: false,
    cellText: true,
    cellNF: true,
  });
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 100)
    throw new Error("Spreadsheet exceeds sheet budget");
  if (
    workbook.SheetNames.some(
      (name) =>
        !Object.hasOwn(workbook.Sheets, name) ||
        !workbook.Sheets[name] ||
        typeof workbook.Sheets[name] !== "object",
    )
  )
    throw new Error("Spreadsheet contains a missing or incomplete worksheet");
  return workbook;
}

export function legacySheetValues(
  workbook: WorkBook,
  index: number,
): LegacySheet {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= workbook.SheetNames.length
  )
    throw new Error("Invalid worksheet index");
  const sheet = workbook.Sheets[workbook.SheetNames[index]];
  if (!sheet)
    throw new Error("Spreadsheet contains a missing or incomplete worksheet");
  const range = utils.decode_range(sheet["!ref"] || "A1");
  const fullRange = utils.decode_range(
    sheet["!fullref"] || sheet["!ref"] || "A1",
  );
  const maxRow = Math.min(range.e.r, LEGACY_SPREADSHEET_MAX_ROWS - 1);
  const maxCol = Math.min(range.e.c, LEGACY_SPREADSHEET_MAX_COLUMNS - 1);
  let remaining = 1024 * 1024;
  let truncated = fullRange.e.r > maxRow || fullRange.e.c > maxCol;
  const rows: string[][] = [];
  // Start at A1 so row/column labels retain their real coordinates.
  for (let r = 0; r <= maxRow && remaining > 0; r++) {
    const row: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      const cell =
        sheet["!data"]?.[r]?.[c] || sheet[utils.encode_cell({ r, c })];
      const value = cell ? String(cell.w ?? cell.v ?? "") : "";
      const text = value.slice(0, Math.min(16_384, remaining));
      if (text.length < value.length) truncated = true;
      remaining -= text.length;
      row.push(text);
    }
    rows.push(row);
  }
  if (rows.length <= maxRow) truncated = true;
  return { rows, truncated };
}
