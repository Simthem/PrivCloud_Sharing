import type { CSSProperties } from "react";
import {
  OFFICE_NS as N,
  OfficeBudget,
  attr,
  children,
  descendants,
  first,
  length,
  number,
  type OfficeBlock,
  type OfficeCell,
  type OfficePage,
  type OfficeParagraph,
  type OfficeRun,
  type OfficeRelationship,
} from "./officePreviewModel.util";
import {
  odfStyles,
  wordParagraphStyle,
  wordStyles,
  wordTextStyle,
} from "./officePreviewStyles.util";

type OdfStyles = ReturnType<typeof odfStyles>;
function odfRuns(
  node: Element,
  styles: OdfStyles,
  budget: OfficeBudget,
  base: CSSProperties = {},
): OfficeRun[] {
  const runs: OfficeRun[] = [];
  const walk = (current: Node, style: CSSProperties, depth: number) => {
    if (depth > 64 || runs.length >= 2048 || budget.chars <= 0) {
      budget.truncated = true;
      return;
    }
    if (current.nodeType === 3) {
      const text = budget.take(current.textContent ?? "");
      if (text) runs.push({ text, style });
      return;
    }
    const element = current as Element;
    if (
      ["scripts", "binary-data", "object", "object-ole", "annotation"].includes(
        element.localName,
      ) ||
      element.namespaceURI === N.draw
    )
      return;
    if (element.namespaceURI === N.text) {
      if (element.localName === "s") {
        runs.push({
          text: budget.take(
            " ".repeat(
              Math.max(1, number(attr(element, N.text, "c"), 1, 1024)),
            ),
          ),
          style,
        });
        return;
      }
      if (element.localName === "tab" || element.localName === "line-break") {
        runs.push({ text: element.localName === "tab" ? "\t" : "\n", style });
        return;
      }
      if (element.localName === "span")
        style = { ...style, ...styles.styleFor(element, "text").text };
    }
    for (const child of Array.from(current.childNodes))
      walk(child, style, depth + 1);
  };
  walk(node, base, 0);
  return runs;
}
function odfImages(node: Element, budget: OfficeBudget): OfficeBlock[] {
  const images = descendants(node, N.draw, "image");
  const count = Math.min(images.length, budget.images);
  if (count < images.length) budget.truncated = true;
  budget.images -= count;
  return images
    .slice(0, count)
    .map((image) => {
      const frame = image.parentElement;
      return {
        kind: "image" as const,
        path: attr(image, N.xlink, "href"),
        width: length(attr(frame, N.svg, "width")),
        height: length(attr(frame, N.svg, "height")),
      };
    })
    .filter(
      (image) => image.path && !/^(?:[a-z][\w+.-]*:|\/\/)/i.test(image.path),
    );
}

export function odfTable(
  node: Element,
  styles: OdfStyles,
  budget: OfficeBudget,
  grid: boolean,
) {
  const rows: { cells: OfficeCell[]; height?: number; index: number }[] = [];
  const widths: number[] = [];
  for (const column of descendants(node, N.table, "table-column")) {
    const style = styles.node(
      "table-column",
      attr(column, N.table, "style-name"),
    );
    const w =
      length(
        attr(
          first(style, N.style, "table-column-properties"),
          N.style,
          "column-width",
        ),
      ) ?? 110;
    const repeats = Math.max(
      1,
      number(attr(column, N.table, "number-columns-repeated"), 1, 100),
    );
    for (let i = 0; i < repeats && widths.length < 100; i++) widths.push(w);
  }
  const sourceRows = descendants(node, N.table, "table-row");
  const maxRows = grid ? 500 : 200,
    maxCols = grid ? 100 : 50;
  for (const row of sourceRows) {
    if (rows.length >= maxRows || budget.cells <= 0 || budget.chars <= 0) {
      budget.truncated = true;
      break;
    }
    // Nested table rows belong to their own table.
    let owner = row.parentElement;
    while (
      owner &&
      !(owner.namespaceURI === N.table && owner.localName === "table")
    )
      owner = owner.parentElement;
    if (owner !== node) continue;
    const cells: OfficeCell[] = [];
    for (const cell of Array.from(row.children).filter(
      (c) =>
        c.namespaceURI === N.table &&
        ["table-cell", "covered-table-cell"].includes(c.localName),
    )) {
      if (cells.length >= maxCols || budget.cells <= 0) {
        budget.truncated = true;
        break;
      }
      const paragraphs = descendants(cell, N.text, "p");
      const runs = paragraphs.flatMap((p, i) => [
        ...(i ? [{ text: "\n" }] : []),
        ...odfRuns(p, styles, budget),
      ]);
      if (!runs.length) {
        const value =
          attr(cell, N.office, "string-value") ||
          attr(cell, N.office, "value") ||
          attr(cell, N.office, "date-value") ||
          attr(cell, N.office, "boolean-value");
        if (value) runs.push({ text: budget.take(value) });
      }
      const style = styles.styleFor(cell, "table-cell");
      const repeats = Math.max(
        1,
        number(attr(cell, N.table, "number-columns-repeated"), 1, maxCols),
      );
      const requestedRepeats =
        Number(attr(cell, N.table, "number-columns-repeated")) || 1;
      if (requestedRepeats > repeats || cells.length + repeats > maxCols)
        budget.truncated = true;
      for (
        let repeat = 0;
        repeat < repeats && cells.length < maxCols && budget.cells > 0;
        repeat++
      ) {
        budget.cells--;
        cells.push({
          runs: repeat
            ? runs.map((run) => ({ ...run, text: budget.take(run.text) }))
            : runs,
          style: { ...style.text, ...style.paragraph },
          colSpan: Math.max(
            1,
            number(attr(cell, N.table, "number-columns-spanned"), 1, maxCols),
          ),
          rowSpan: Math.max(
            1,
            number(attr(cell, N.table, "number-rows-spanned"), 1, maxRows),
          ),
          covered: cell.localName === "covered-table-cell",
          formula: attr(cell, N.table, "formula").slice(0, 4096) || undefined,
        });
      }
    }
    const rowStyle = styles.node("table-row", attr(row, N.table, "style-name"));
    const height = length(
      attr(
        first(rowStyle, N.style, "table-row-properties"),
        N.style,
        "row-height",
      ),
      300,
    );
    const repeats = Math.max(
      1,
      number(attr(row, N.table, "number-rows-repeated"), 1, maxRows),
    );
    if ((Number(attr(row, N.table, "number-rows-repeated")) || 1) > repeats)
      budget.truncated = true;
    for (let repeat = 0; repeat < repeats && rows.length < maxRows; repeat++) {
      if (repeat && budget.cells < Math.max(1, cells.length)) {
        budget.truncated = true;
        break;
      }
      const copy = repeat
        ? cells.map((cell) => ({
            ...cell,
            runs: cell.runs.map((run) => ({
              ...run,
              text: budget.take(run.text),
            })),
          }))
        : cells;
      if (repeat) budget.cells -= Math.max(1, cells.length);
      if (!cells.length) budget.cells--;
      rows.push({ cells: copy, height, index: rows.length + 1 });
    }
  }
  return {
    kind: "table" as const,
    rows,
    widths,
    name: attr(node, N.table, "name").slice(0, 128),
    grid,
  };
}

export function parseOdfDocument(
  root: Element,
  styles: OdfStyles,
  budget = new OfficeBudget(),
): OfficeBlock[] {
  const blocks: OfficeBlock[] = [];
  const listNumbers = new Map<Element, number>();
  const visit = (
    node: Element,
    depth: number,
    listLevel = 0,
    marker?: string,
  ) => {
    if (budget.nodes-- <= 0 || budget.chars <= 0 || depth > 64) {
      budget.truncated = true;
      return;
    }
    if (
      ["scripts", "binary-data", "object", "object-ole", "annotation"].includes(
        node.localName,
      )
    )
      return;
    if (node.namespaceURI === N.text && ["p", "h"].includes(node.localName)) {
      const style = styles.styleFor(node, "paragraph");
      blocks.push({
        kind: "paragraph",
        runs: odfRuns(node, styles, budget, style.text),
        style: {
          ...style.paragraph,
          ...(listLevel ? { marginLeft: listLevel * 24 } : {}),
        },
        heading:
          node.localName === "h"
            ? Math.max(1, number(attr(node, N.text, "outline-level"), 1, 6))
            : undefined,
        marker,
        pageBreakBefore: style.paragraph.breakBefore === "page",
      });
      blocks.push(...odfImages(node, budget));
      return;
    }
    if (node.namespaceURI === N.table && node.localName === "table") {
      blocks.push(odfTable(node, styles, budget, false));
      return;
    }
    if (node.namespaceURI === N.draw && node.localName === "frame") {
      blocks.push(...odfImages(node, budget));
      if (!first(node, N.draw, "text-box")) return;
    }
    if (node.namespaceURI === N.text && node.localName === "list") {
      listNumbers.set(node, 0);
      for (const item of children(node, N.text, "list-item")) {
        const count = (listNumbers.get(node) ?? 0) + 1;
        listNumbers.set(node, count);
        const name = attr(node, N.text, "style-name");
        const document = node.ownerDocument;
        const definition = descendants(document, N.text, "list-style").find(
          (style) => attr(style, N.style, "name") === name,
        );
        const ordered = !!first(definition, N.text, "list-level-style-number");
        Array.from(item.children).forEach((child, i) =>
          visit(
            child,
            depth + 1,
            listLevel + 1,
            i === 0 ? (ordered ? `${count}.` : "•") : undefined,
          ),
        );
      }
      return;
    }
    for (const child of Array.from(node.children))
      visit(child, depth + 1, listLevel, marker);
  };
  visit(root, 0);
  return blocks;
}

export function odfDocumentPage(
  doc: Document,
  styleDoc?: Document,
): OfficePage {
  const styles = odfStyles([...(styleDoc ? [styleDoc] : []), doc]);
  const budget = new OfficeBudget();
  const body =
    first(doc, N.office, "text") ??
    first(doc, N.office, "body") ??
    doc.documentElement;
  const page = first(styleDoc ?? doc, N.style, "page-layout-properties");
  return {
    blocks: parseOdfDocument(body, styles, budget),
    width: length(attr(page, N.fo, "page-width")) ?? 794,
    height: length(attr(page, N.fo, "page-height")) ?? 1123,
    padding: ["margin-top", "margin-right", "margin-bottom", "margin-left"].map(
      (key) => Math.max(0, length(attr(page, N.fo, key)) ?? 48),
    ),
    truncated: budget.truncated,
  };
}

function wordRuns(
  node: Element,
  styles: ReturnType<typeof wordStyles>,
  base: CSSProperties,
  palette: Record<string, string>,
  budget: OfficeBudget,
): OfficeRun[] {
  const runs: OfficeRun[] = [];
  for (const run of descendants(node, N.word, "r").slice(0, 2048)) {
    let ancestor = run.parentElement;
    let deleted = false;
    while (ancestor && ancestor !== node) {
      if (ancestor.namespaceURI === N.word && ancestor.localName === "del") {
        deleted = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (deleted) continue;
    const rPr = children(run, N.word, "rPr")[0];
    const name = attr(first(rPr, N.word, "rStyle"), N.word, "val");
    const style = {
      ...base,
      ...(name ? styles.resolve(name).text : {}),
      ...wordTextStyle(rPr, palette),
    };
    for (const child of Array.from(run.children)) {
      if (child.namespaceURI !== N.word) continue;
      if (child.localName === "t")
        runs.push({ text: budget.take(child.textContent ?? ""), style });
      if (["br", "cr", "tab"].includes(child.localName))
        runs.push({ text: child.localName === "tab" ? "\t" : "\n", style });
    }
  }
  return runs;
}
function wordImages(
  node: Element,
  relationships: Map<string, OfficeRelationship>,
  budget: OfficeBudget,
): OfficeBlock[] {
  const images = descendants(node, N.drawing, "blip");
  const count = Math.min(images.length, budget.images);
  if (count < images.length) budget.truncated = true;
  budget.images -= count;
  return images.slice(0, count).flatMap((image) => {
    const path = relationships.get(attr(image, N.relationship, "embed"))?.path;
    if (!path) return [];
    let parent = image.parentElement;
    let extent: Element | undefined;
    for (
      let depth = 0;
      parent && depth < 8;
      depth++, parent = parent.parentElement
    ) {
      extent = Array.from(parent.children).find(
        (child) => child.localName === "extent",
      );
      if (extent) break;
    }
    return [
      {
        kind: "image" as const,
        path,
        width: extent
          ? Math.max(1, number(extent.getAttribute("cx"), 0, 15_240_000) / 9525)
          : undefined,
        height: extent
          ? Math.max(1, number(extent.getAttribute("cy"), 0, 15_240_000) / 9525)
          : undefined,
      },
    ];
  });
}
function wordCellStyle(cell: Element): CSSProperties {
  const properties = children(cell, N.word, "tcPr")[0];
  const result: CSSProperties = {};
  const fill = attr(first(properties, N.word, "shd"), N.word, "fill");
  if (/^[\da-f]{6}$/i.test(fill)) result.backgroundColor = "#" + fill;
  const vertical = attr(first(properties, N.word, "vAlign"), N.word, "val");
  if (["top", "center", "bottom"].includes(vertical))
    result.verticalAlign =
      vertical === "center" ? "middle" : (vertical as "top");
  const borders = first(properties, N.word, "tcBorders");
  for (const [tag, css] of [
    ["top", "borderTop"],
    ["bottom", "borderBottom"],
    ["left", "borderLeft"],
    ["right", "borderRight"],
  ] as const) {
    const border = first(borders, N.word, tag),
      shade = attr(border, N.word, "color");
    if (border && /^[\da-f]{6}$/i.test(shade))
      result[css] =
        `${Math.max(1, number(attr(border, N.word, "sz"), 8, 48) / 6)}px solid #${shade}`;
  }
  return result;
}
export function wordDocumentPage(
  doc: Document,
  styleDoc: Document | undefined,
  numbering: Document | undefined,
  relationships: Map<string, OfficeRelationship>,
  palette: Record<string, string>,
): OfficePage {
  const styles = wordStyles(styleDoc, palette);
  const budget = new OfficeBudget();
  const counters = new Map<string, number>();
  const paragraph = (node: Element): OfficeParagraph => {
    const pPr = children(node, N.word, "pPr")[0];
    const inherited = styles.resolve(
      attr(first(pPr, N.word, "pStyle"), N.word, "val"),
    );
    const style = { ...inherited.paragraph, ...wordParagraphStyle(pPr) };
    const numId = attr(first(pPr, N.word, "numId"), N.word, "val");
    const level = Math.max(
      0,
      number(attr(first(pPr, N.word, "ilvl"), N.word, "val"), 0, 8),
    );
    let marker: string | undefined;
    if (numId && numId !== "0") {
      const abstractId = attr(
        first(
          descendants(numbering, N.word, "num").find(
            (n) => attr(n, N.word, "numId") === numId,
          ),
          N.word,
          "abstractNumId",
        ),
        N.word,
        "val",
      );
      const definition = descendants(numbering, N.word, "abstractNum").find(
        (n) => attr(n, N.word, "abstractNumId") === abstractId,
      );
      const lvl = children(definition, N.word, "lvl").find(
        (n) => attr(n, N.word, "ilvl") === String(level),
      );
      const format = attr(first(lvl, N.word, "numFmt"), N.word, "val");
      const key = numId + ":" + level;
      const count =
        (counters.get(key) ??
          Math.max(
            0,
            number(attr(first(lvl, N.word, "start"), N.word, "val"), 1) - 1,
          )) + 1;
      counters.set(key, count);
      marker =
        format === "bullet" || !format
          ? "•"
          : format === "lowerLetter"
            ? String.fromCharCode(97 + ((count - 1) % 26)) + "."
            : `${count}.`;
      style.marginLeft = (level + 1) * 24;
    }
    const pageBreak = !!first(pPr, N.word, "pageBreakBefore");
    return {
      kind: "paragraph",
      runs: wordRuns(node, styles, inherited.text, palette, budget),
      style,
      heading: inherited.heading,
      marker,
      pageBreakBefore: pageBreak,
    };
  };
  const table = (node: Element): OfficeBlock => {
    const rows: { cells: OfficeCell[] }[] = [];
    const widths = children(first(node, N.word, "tblGrid"), N.word, "gridCol")
      .slice(0, 50)
      .map((c) => Math.max(40, number(attr(c, N.word, "w"), 1440) / 15));
    for (const row of children(node, N.word, "tr").slice(0, 200)) {
      if (budget.cells <= 0) {
        budget.truncated = true;
        break;
      }
      const cells: OfficeCell[] = [];
      for (const cell of children(row, N.word, "tc")) {
        if (cells.length >= 50 || budget.cells-- <= 0) {
          budget.truncated = true;
          break;
        }
        const paragraphs = children(cell, N.word, "p");
        const colSpan = Math.max(
          1,
          number(
            attr(first(cell, N.word, "gridSpan"), N.word, "val"),
            1,
            50 - cells.length,
          ),
        );
        const merge = first(
          children(cell, N.word, "tcPr")[0],
          N.word,
          "vMerge",
        );
        const covered = !!merge && attr(merge, N.word, "val") !== "restart";
        if (covered) {
          for (let i = rows.length - 1; i >= 0; i--) {
            const above = rows[i].cells[cells.length];
            if (above && !above.covered) {
              above.rowSpan = (above.rowSpan ?? 1) + 1;
              break;
            }
          }
        }
        cells.push({
          runs: paragraphs.flatMap((p, i) => [
            ...(i ? [{ text: "\n" }] : []),
            ...paragraph(p).runs,
          ]),
          style: wordCellStyle(cell),
          colSpan,
          covered,
        });
        for (let i = 1; i < colSpan; i++)
          cells.push({ runs: [], covered: true });
      }
      rows.push({ cells });
    }
    if (children(node, N.word, "tr").length > rows.length)
      budget.truncated = true;
    return { kind: "table", rows, widths };
  };
  const blocks: OfficeBlock[] = [];
  const visit = (node: Element, depth = 0) => {
    if (depth > 64 || budget.nodes-- <= 0 || budget.chars <= 0) {
      budget.truncated = true;
      return;
    }
    if (node.namespaceURI === N.word && node.localName === "p") {
      blocks.push(paragraph(node), ...wordImages(node, relationships, budget));
      return;
    }
    if (node.namespaceURI === N.word && node.localName === "tbl") {
      blocks.push(table(node));
      return;
    }
    if (["del", "instrText", "object", "altChunk"].includes(node.localName))
      return;
    for (const child of Array.from(node.children)) visit(child, depth + 1);
  };
  visit(first(doc, N.word, "body") ?? doc.documentElement);
  const section = descendants(doc, N.word, "sectPr").at(-1);
  const size = first(section, N.word, "pgSz"),
    margins = first(section, N.word, "pgMar");
  return {
    blocks,
    width: Math.max(280, number(attr(size, N.word, "w"), 11906, 24000) / 15),
    height: Math.max(400, number(attr(size, N.word, "h"), 16838, 30000) / 15),
    padding: ["top", "right", "bottom", "left"].map((key) =>
      Math.max(0, number(attr(margins, N.word, key), 720, 3600) / 15),
    ),
    truncated: budget.truncated,
  };
}
