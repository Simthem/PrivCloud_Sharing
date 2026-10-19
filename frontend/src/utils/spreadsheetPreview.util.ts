import type { CSSProperties } from "react";
import {
  OFFICE_NS as N,
  OfficeBudget,
  alignment,
  children,
  color,
  descendants,
  first,
  font,
  number,
  type OfficeCell,
  type OfficePage,
  type OfficeRun,
} from "./officePreviewModel.util";

export function spreadsheetColumn(index: number): string {
  let label = "";
  for (
    let value = Math.max(0, Math.min(16383, index)) + 1;
    value > 0;
    value = Math.floor((value - 1) / 26)
  )
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}
export function spreadsheetReference(
  value: string,
): { row: number; col: number } | null {
  const match = value.match(/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i);
  if (!match) return null;
  let col = 0;
  for (const letter of match[1].toUpperCase())
    col = col * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return col <= 16384 && row <= 1048576 ? { row, col: col - 1 } : null;
}
const indexedColors = [
  "#000000",
  "#ffffff",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  "#ff00ff",
  "#00ffff",
];
const themeKeys = [
  "lt1",
  "dk1",
  "lt2",
  "dk2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];
function cellColor(
  node: Element | undefined,
  palette: Record<string, string>,
): string | undefined {
  if (!node) return undefined;
  let shade = color(node.getAttribute("rgb"));
  if (!shade && node.hasAttribute("theme"))
    shade = palette[themeKeys[number(node.getAttribute("theme"), -1, 64)]];
  if (!shade && node.hasAttribute("indexed"))
    shade = indexedColors[number(node.getAttribute("indexed"), -1, 64) % 8];
  const tint = number(node.getAttribute("tint"), 0, 1);
  if (!shade || !tint) return shade;
  return (
    "#" +
    shade
      .slice(1)
      .match(/../g)!
      .map((part) => {
        const n = parseInt(part, 16);
        return Math.round(tint < 0 ? n * (1 + tint) : n + (255 - n) * tint)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
function spreadsheetTextStyle(
  node: Element | undefined,
  palette: Record<string, string>,
): CSSProperties {
  if (!node) return {};
  const style: CSSProperties = {};
  for (const [tag, key, enabled, disabled] of [
    ["b", "fontWeight", 700, 400],
    ["i", "fontStyle", "italic", "normal"],
  ] as const) {
    const item = first(node, N.sheet, tag);
    if (item)
      Object.assign(style, {
        [key]: ["0", "false"].includes(item.getAttribute("val") ?? "1")
          ? disabled
          : enabled,
      });
  }
  const size =
    (number(first(node, N.sheet, "sz")?.getAttribute("val")) * 4) / 3;
  if (size > 0) style.fontSize = Math.min(100, size);
  const face = font(
    first(node, N.sheet, "name")?.getAttribute("val") ||
      first(node, N.sheet, "rFont")?.getAttribute("val"),
  );
  if (face) style.fontFamily = face;
  const shade = cellColor(first(node, N.sheet, "color"), palette);
  if (shade) style.color = shade;
  const decoration = [];
  if (first(node, N.sheet, "u")) decoration.push("underline");
  if (first(node, N.sheet, "strike")) decoration.push("line-through");
  if (decoration.length) style.textDecoration = decoration.join(" ");
  return style;
}
export function spreadsheetStrings(
  doc: Document | undefined,
  palette: Record<string, string>,
): OfficeRun[][] {
  const budget = new OfficeBudget();
  return descendants(doc, N.sheet, "si")
    .slice(0, 50_000)
    .map((si) => spreadsheetRuns(si, palette, budget));
}
function spreadsheetRuns(
  node: Element | undefined,
  palette: Record<string, string>,
  budget: OfficeBudget,
): OfficeRun[] {
  if (!node) return [];
  const rich = children(node, N.sheet, "r");
  if (rich.length)
    return rich
      .slice(0, 256)
      .map((run) => ({
        text: budget.take(first(run, N.sheet, "t")?.textContent ?? ""),
        style: spreadsheetTextStyle(first(run, N.sheet, "rPr"), palette),
      }));
  return [
    {
      text: budget.take(
        children(node, N.sheet, "t")
          .map((t) => t.textContent ?? "")
          .join(""),
      ),
    },
  ];
}
const builtinFormats: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  14: "m/d/yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  45: "mm:ss",
  46: "[h]:mm:ss",
  49: "@",
};
export function spreadsheetStyles(
  doc: Document | undefined,
  palette: Record<string, string>,
) {
  const fonts = children(first(doc, N.sheet, "fonts"), N.sheet, "font");
  const fills = children(first(doc, N.sheet, "fills"), N.sheet, "fill");
  const borders = children(first(doc, N.sheet, "borders"), N.sheet, "border");
  const formats = new Map<number, string>();
  for (const item of descendants(doc, N.sheet, "numFmt"))
    formats.set(
      number(item.getAttribute("numFmtId")),
      (item.getAttribute("formatCode") ?? "General").slice(0, 256),
    );
  const values = children(first(doc, N.sheet, "cellXfs"), N.sheet, "xf")
    .slice(0, 10_000)
    .map((xf) => {
      const style = spreadsheetTextStyle(
        fonts[number(xf.getAttribute("fontId"))],
        palette,
      );
      const fill = first(
        fills[number(xf.getAttribute("fillId"))],
        N.sheet,
        "patternFill",
      );
      if (fill?.getAttribute("patternType") === "solid")
        style.backgroundColor = cellColor(
          first(fill, N.sheet, "fgColor"),
          palette,
        );
      const border = borders[number(xf.getAttribute("borderId"))];
      for (const [tag, css] of [
        ["left", "borderLeft"],
        ["right", "borderRight"],
        ["top", "borderTop"],
        ["bottom", "borderBottom"],
      ] as const) {
        const item = children(border, N.sheet, tag)[0];
        const line = item?.getAttribute("style");
        if (line && line !== "none")
          style[css] =
            `${line === "thick" ? 3 : line === "medium" ? 2 : 1}px ${line === "dotted" ? "dotted" : line === "dashed" ? "dashed" : line === "double" ? "double" : "solid"} ${cellColor(first(item, N.sheet, "color"), palette) ?? "#444444"}`;
      }
      const a = first(xf, N.sheet, "alignment");
      const align = alignment(a?.getAttribute("horizontal") ?? "");
      if (align) style.textAlign = align;
      const vertical = a?.getAttribute("vertical");
      if (vertical && ["top", "center", "bottom"].includes(vertical))
        style.verticalAlign =
          vertical === "center" ? "middle" : (vertical as "top");
      if (a?.getAttribute("wrapText") === "1") style.whiteSpace = "pre-wrap";
      const indent = number(a?.getAttribute("indent"), 0, 10);
      if (indent > 0) style.paddingLeft = indent * 10;
      const numFmt = number(xf.getAttribute("numFmtId"));
      return {
        style,
        format: formats.get(numFmt) ?? builtinFormats[numFmt] ?? "General",
      };
    });
  return { values, palette };
}

/** Use the saved numeric/formula result. Formulas and external links are never evaluated. */
export function formatSpreadsheetNumber(
  value: string,
  format: string,
  date1904: boolean,
  locale: string,
): string {
  const n = Number(value);
  if (!Number.isFinite(n) || format === "General" || format === "@")
    return value;
  const cleaned = format.replace(/"[^"]*"|\\.|\[(?!h+\])[^^\]]*\]/gi, "");
  if (
    /[ydh]/i.test(cleaned) ||
    (/[ms]/i.test(cleaned) && cleaned.includes(":"))
  ) {
    const days = Math.floor(n);
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(
      epoch +
        (days - (!date1904 && days >= 60 ? 1 : 0)) * 86_400_000 +
        Math.round((n - days) * 86_400_000),
    );
    if (!Number.isFinite(date.getTime())) return value;
    const options: Intl.DateTimeFormatOptions = { timeZone: "UTC" };
    if (/[yd]/i.test(cleaned)) {
      options.year = /y/i.test(cleaned) ? "numeric" : undefined;
      options.month = /mmm/i.test(cleaned) ? "short" : "2-digit";
      options.day = /d/i.test(cleaned) ? "2-digit" : undefined;
    }
    if (/h|s/i.test(cleaned)) {
      options.hour = /h/i.test(cleaned) ? "2-digit" : undefined;
      options.minute = "2-digit";
      options.second = /s/i.test(cleaned) ? "2-digit" : undefined;
      options.hour12 = /AM\/PM/i.test(cleaned);
    }
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
  const section = cleaned.split(";")[0];
  const decimals = Math.min(10, (section.match(/\.([0#]+)/)?.[1] ?? "").length);
  const percent = section.includes("%");
  const currency = format.includes("€")
    ? "EUR"
    : format.includes("$")
      ? "USD"
      : format.includes("£")
        ? "GBP"
        : undefined;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: section.includes(","),
    ...(percent
      ? { style: "percent" as const }
      : currency
        ? { style: "currency" as const, currency }
        : {}),
  }).format(n);
}

export function parseSpreadsheetSheet(
  doc: Document,
  shared: OfficeRun[][],
  styles: ReturnType<typeof spreadsheetStyles>,
  date1904: boolean,
  locale: string,
): OfficePage {
  const budget = new OfficeBudget();
  const sourceRows = children(first(doc, N.sheet, "sheetData"), N.sheet, "row");
  const firstRow = Math.max(1, Number(sourceRows[0]?.getAttribute("r")) || 1);
  const firstReference = spreadsheetReference(
    first(sourceRows[0], N.sheet, "c")?.getAttribute("r") ?? "A1",
  );
  const columnOffset =
    (firstReference?.col ?? 0) >= 100 ? firstReference!.col : 0;
  const rows = new Map<
    number,
    { cells: OfficeCell[]; height?: number; index: number }
  >();
  let columns = 1;
  for (const [rowIndex, row] of sourceRows.entries()) {
    const index = Number(row.getAttribute("r")) || rowIndex + 1;
    if (index < firstRow || index >= firstRow + 500 || budget.cells <= 0) {
      budget.truncated = true;
      continue;
    }
    const cells: OfficeCell[] = [];
    let implicitColumn = columnOffset;
    for (const node of children(row, N.sheet, "c")) {
      const reference = spreadsheetReference(
        node.getAttribute("r") ??
          `${spreadsheetColumn(implicitColumn)}${index}`,
      );
      if (!reference) continue;
      implicitColumn = reference.col + 1;
      const col = reference.col - columnOffset;
      if (col < 0 || col >= 100 || budget.cells-- <= 0) {
        budget.truncated = true;
        continue;
      }
      const cellStyle = styles.values[number(node.getAttribute("s"))];
      const type = node.getAttribute("t");
      let raw = first(node, N.sheet, "v")?.textContent ?? "";
      const formula = first(node, N.sheet, "f")?.textContent?.slice(0, 4096);
      let runs: OfficeRun[];
      if (type === "s")
        runs = (shared[Number(raw)] ?? [{ text: "" }]).map((run) => ({
          ...run,
          text: budget.take(run.text),
        }));
      else if (type === "inlineStr")
        runs = spreadsheetRuns(
          first(node, N.sheet, "is"),
          styles.palette,
          budget,
        );
      else {
        if (type === "b") raw = raw === "1" ? "TRUE" : "FALSE";
        else if ((!type || type === "n") && raw)
          raw = formatSpreadsheetNumber(
            raw,
            cellStyle?.format ?? "General",
            date1904,
            locale,
          );
        else if (!raw && formula) raw = "=" + formula;
        runs = [{ text: budget.take(raw) }];
      }
      cells[col] = {
        runs,
        style: {
          ...cellStyle?.style,
          textAlign:
            cellStyle?.style.textAlign ??
            ((!type || type === "n") && raw ? "right" : "left"),
        },
        formula,
      };
      columns = Math.max(columns, col + 1);
    }
    rows.set(index, {
      cells,
      index,
      height: row.hasAttribute("ht")
        ? Math.max(18, (number(row.getAttribute("ht"), 15, 300) * 4) / 3)
        : undefined,
    });
  }
  const sorted = [...rows.values()].sort((a, b) => a.index - b.index);
  // Fill small gaps so merged ranges remain aligned, without allocating huge sparse rows.
  const grid: typeof sorted = [];
  let next = firstRow;
  for (const row of sorted) {
    while (next < row.index && grid.length < 500 && row.index - next < 500)
      grid.push({ cells: [], index: next++ });
    if (grid.length >= 500) {
      budget.truncated = true;
      break;
    }
    grid.push(row);
    next = row.index + 1;
  }
  const byIndex = new Map(grid.map((row) => [row.index, row]));
  let mergeBudget = 100_000;
  for (const item of descendants(doc, N.sheet, "mergeCell").slice(0, 2000)) {
    const [start, end] = (item.getAttribute("ref") ?? "")
      .split(":")
      .map(spreadsheetReference);
    if (!start || !end || start.row > end.row || start.col > end.col) continue;
    const col = start.col - columnOffset;
    const rowSpan = end.row - start.row + 1,
      colSpan = end.col - start.col + 1;
    if (
      rowSpan > 500 ||
      col < 0 ||
      col + colSpan > 100 ||
      !byIndex.has(start.row) ||
      !byIndex.has(end.row)
    ) {
      budget.truncated = true;
      continue;
    }
    if (rowSpan * colSpan > mergeBudget) {
      budget.truncated = true;
      break;
    }
    mergeBudget -= rowSpan * colSpan;
    const cell = byIndex.get(start.row)!.cells[col] ?? { runs: [] };
    cell.rowSpan = rowSpan;
    cell.colSpan = colSpan;
    byIndex.get(start.row)!.cells[col] = cell;
    for (let r = start.row; r <= end.row; r++)
      for (let c = start.col; c <= end.col; c++) {
        if (r === start.row && c === start.col) continue;
        const target = byIndex.get(r);
        if (target)
          target.cells[c - columnOffset] = { runs: [], covered: true };
      }
    columns = Math.max(columns, col + colSpan);
  }
  const widths = Array.from({ length: columns }, () => 96);
  for (const col of descendants(doc, N.sheet, "col")) {
    const min = Math.max(columnOffset, number(col.getAttribute("min")) - 1),
      max = Math.min(
        columnOffset + columns - 1,
        number(col.getAttribute("max")) - 1,
      );
    for (let c = min; c <= max; c++)
      widths[c - columnOffset] = Math.max(
        32,
        Math.min(500, number(col.getAttribute("width"), 13, 100) * 7 + 5),
      );
  }
  for (const row of grid)
    for (let c = 0; c < columns; c++) row.cells[c] ??= { runs: [] };
  return {
    blocks: [{ kind: "table", rows: grid, widths, grid: true, columnOffset }],
    width: widths.reduce((a, b) => a + b, 48),
    height: 600,
    truncated: budget.truncated,
  };
}

export function parseDelimitedSheet(
  text: string,
  delimiter: string,
  truncated: boolean,
): OfficePage {
  const budget = new OfficeBudget();
  const rows: { cells: OfficeCell[]; index: number }[] = [];
  let cells: OfficeCell[] = [],
    value = "",
    quoted = false;
  const finishCell = () => {
    if (cells.length >= 100 || budget.cells-- <= 0) {
      budget.truncated = true;
      value = "";
      return;
    }
    cells.push({ runs: [{ text: budget.take(value) }] });
    value = "";
  };
  const finishRow = () => {
    finishCell();
    rows.push({ cells, index: rows.length + 1 });
    cells = [];
  };
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted || value.length === 0) quoted = !quoted;
      else value += char;
    } else if (!quoted && char === delimiter) finishCell();
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      finishRow();
    } else if (value.length < 16_384) value += char;
    else budget.truncated = true;
  }
  if ((value || cells.length) && rows.length < 500) finishRow();
  const columns = Math.max(1, ...rows.map((r) => r.cells.length));
  for (const row of rows)
    while (row.cells.length < columns) row.cells.push({ runs: [] });
  return {
    blocks: [
      { kind: "table", rows, widths: Array(columns).fill(140), grid: true },
    ],
    width: columns * 140 + 48,
    height: 600,
    truncated: truncated || budget.truncated || rows.length >= 500,
  };
}
