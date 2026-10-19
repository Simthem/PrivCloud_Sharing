import { openPreviewZip, OFFICE_XML_MAX_BYTES } from "./officePreview.util";
import { readPreviewBytes, type PreviewByteSource } from "./previewRange.util";
import {
  OFFICE_NS as N,
  OfficeBudget,
  attr,
  children,
  descendants,
  first,
  number,
  parseOfficeRelationships,
  parseOfficeXml,
  relationshipPart,
  resolveOfficePart,
  officeImageMime,
  type OfficeDocument,
} from "./officePreviewModel.util";
import { odfStyles, officeTheme } from "./officePreviewStyles.util";
import {
  odfDocumentPage,
  odfTable,
  wordDocumentPage,
} from "./documentPreview.util";
import {
  parseDelimitedSheet,
  parseSpreadsheetSheet,
  spreadsheetStrings,
  spreadsheetStyles,
} from "./spreadsheetPreview.util";
import { odpSlidePage, powerpointSlidePage } from "./presentationPreview.util";
import { parseRtfPreview } from "./rtfPreview.util";
import {
  isLegacySpreadsheetMimeType,
  openLegacySpreadsheet,
} from "./legacySpreadsheetPreview.util";

function delimitedSeparator(text: string, mimeType: string): string {
  if (mimeType === "text/tab-separated-values") return "\t";
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (const char of text.slice(0, 16_384)) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "\n" || char === "\r")) break;
    if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

/** Read metadata and only the selected content part. No conversion server or external resource is used. */
export async function openOfficeDocument(
  source: PreviewByteSource,
  signal: AbortSignal,
  mimeType: string,
  parser: DOMParser,
  locale = "en-US",
): Promise<OfficeDocument> {
  const normalized = mimeType.toLowerCase().split(";")[0];
  if (isLegacySpreadsheetMimeType(normalized))
    return openLegacySpreadsheet(source, signal);
  if (
    [
      "text/csv",
      "application/csv",
      "text/tab-separated-values",
      "application/rtf",
      "text/rtf",
    ].includes(normalized)
  ) {
    const limit = normalized.endsWith("rtf") ? 2 * 1024 * 1024 : 1024 * 1024;
    const bytes = await readPreviewBytes(
      source,
      0,
      Math.min(source.size, limit),
      signal,
    );
    const text = new TextDecoder(
      normalized.endsWith("rtf") ? "windows-1252" : "utf-8",
    )
      .decode(bytes)
      .replace(/^\uFEFF/, "");
    const page = normalized.endsWith("rtf")
      ? parseRtfPreview(text)
      : parseDelimitedSheet(
          text,
          delimitedSeparator(text, normalized),
          source.size > bytes.length,
        );
    if (source.size > bytes.length) page.truncated = true;
    return {
      kind: normalized.endsWith("rtf") ? "document" : "workbook",
      units: [{ name: "", key: "content" }],
      load: async () => page,
      image: async () => null,
    };
  }
  const flat = normalized.includes("flat") || normalized.includes("flat-xml");
  let zip: Awaited<ReturnType<typeof openPreviewZip>> | undefined;
  let flatDocument: Document | undefined;
  if (flat) {
    if (source.size > OFFICE_XML_MAX_BYTES)
      throw new Error("Document XML exceeds preview budget");
    flatDocument = parseOfficeXml(
      new TextDecoder().decode(
        await readPreviewBytes(source, 0, source.size, signal),
      ),
      parser,
    );
  } else zip = await openPreviewZip(source, signal);
  let metadataBytes = 0;
  const xml = async (
    path: string,
    activeSignal = signal,
    metadata = false,
  ): Promise<Document | undefined> => {
    activeSignal.throwIfAborted();
    signal.throwIfAborted();
    if (!zip?.has(path)) return undefined;
    if (metadata) {
      metadataBytes += zip.expandedSize(path) ?? 0;
      if (metadataBytes > 32 * 1024 * 1024)
        throw new Error("Document metadata exceeds preview budget");
    }
    return parseOfficeXml(
      new TextDecoder().decode(
        await zip.read(path, OFFICE_XML_MAX_BYTES, activeSignal),
      ),
      parser,
    );
  };
  const relations = async (path: string, activeSignal = signal) => {
    const doc = await xml(relationshipPart(path), activeSignal);
    return doc ? parseOfficeRelationships(doc, path) : new Map();
  };
  let imageBytes = 0,
    imageCount = 0;
  const image = async (
    path: string,
    activeSignal = signal,
  ): Promise<Uint8Array | null> => {
    signal.throwIfAborted();
    activeSignal.throwIfAborted();
    const safePath = resolveOfficePart("content.xml", path);
    if (!zip || !safePath || !zip.has(safePath) || imageCount >= 64)
      return null;
    const expanded = zip.expandedSize(safePath) ?? 0;
    if (expanded > 8 * 1024 * 1024 || imageBytes + expanded > 32 * 1024 * 1024)
      return null;
    imageCount++;
    imageBytes += expanded;
    const bytes = await zip.read(safePath, 8 * 1024 * 1024, activeSignal);
    return officeImageMime(bytes) ? bytes : null;
  };
  const resetImages = () => {
    imageBytes = 0;
    imageCount = 0;
  };
  const content =
    flatDocument ??
    (zip?.has("content.xml")
      ? await xml("content.xml", signal, true)
      : undefined);
  if (content) {
    const stylesDoc = await xml("styles.xml", signal, true);
    const spreadsheet = first(content, N.office, "spreadsheet");
    if (spreadsheet) {
      const tables = children(spreadsheet, N.table, "table").slice(0, 100);
      if (!tables.length) throw new Error("No spreadsheet sheets");
      const styles = odfStyles([...(stylesDoc ? [stylesDoc] : []), content]);
      return {
        kind: "workbook",
        units: tables.map((table, i) => ({
          name: attr(table, N.table, "name").slice(0, 128),
          key: String(i),
        })),
        image,
        load: async (index, activeSignal = signal) => {
          signal.throwIfAborted();
          activeSignal.throwIfAborted();
          resetImages();
          if (!tables[index]) throw new Error("Invalid worksheet index");
          const budget = new OfficeBudget();
          const table = odfTable(tables[index], styles, budget, true);
          const count = Math.max(
            1,
            ...table.rows.map((row) => row.cells.length),
          );
          const widths = Array.from(
            { length: count },
            (_, i) => table.widths[i] ?? 110,
          );
          for (const row of table.rows)
            while (row.cells.length < count) row.cells.push({ runs: [] });
          return {
            blocks: [{ ...table, widths }],
            width: widths.reduce((a, b) => a + b, 48),
            height: 600,
            truncated: budget.truncated,
          };
        },
      };
    }
    const presentation = first(content, N.office, "presentation");
    if (presentation) {
      const pages = children(presentation, N.draw, "page").slice(0, 200);
      if (!pages.length) throw new Error("No presentation slides");
      return {
        kind: "presentation",
        units: pages.map((page, i) => ({
          name: attr(page, N.draw, "name").slice(0, 128),
          key: String(i),
        })),
        image,
        load: async (index, activeSignal = signal) => {
          signal.throwIfAborted();
          activeSignal.throwIfAborted();
          resetImages();
          if (!pages[index]) throw new Error("Invalid slide index");
          return odpSlidePage(pages[index], content, stylesDoc);
        },
      };
    }
    const page = odfDocumentPage(content, stylesDoc);
    return {
      kind: "document",
      units: [{ name: "", key: "content.xml" }],
      image,
      load: async () => page,
    };
  }
  if (zip?.has("word/document.xml")) {
    const [doc, styles, numbering, theme, relationship] = await Promise.all([
      xml("word/document.xml", signal, true),
      xml("word/styles.xml", signal, true),
      xml("word/numbering.xml", signal, true),
      xml("word/theme/theme1.xml", signal, true),
      relations("word/document.xml"),
    ]);
    const page = wordDocumentPage(
      doc!,
      styles,
      numbering,
      relationship,
      officeTheme(theme),
    );
    return {
      kind: "document",
      units: [{ name: "", key: "word/document.xml" }],
      image,
      load: async () => page,
    };
  }
  if (zip?.has("xl/workbook.xml")) {
    const [workbook, relationship] = await Promise.all([
      xml("xl/workbook.xml", signal, true),
      relations("xl/workbook.xml"),
    ]);
    const part = (suffix: string, fallback: string) =>
      [...relationship.values()].find((rel) => rel.type.endsWith(suffix))
        ?.path ?? fallback;
    const [theme, styleXml, sharedXml] = await Promise.all([
      xml("xl/theme/theme1.xml", signal, true),
      xml(part("/styles", "xl/styles.xml"), signal, true),
      xml(part("/sharedStrings", "xl/sharedStrings.xml"), signal, true),
    ]);
    const palette = officeTheme(theme),
      styles = spreadsheetStyles(styleXml, palette),
      strings = spreadsheetStrings(sharedXml, palette);
    const date1904 =
      first(workbook, N.sheet, "workbookPr")?.getAttribute("date1904") === "1";
    const sheets = descendants(workbook, N.sheet, "sheet")
      .flatMap((sheet) => {
        const rel = relationship.get(attr(sheet, N.relationship, "id"));
        return rel?.type.endsWith("/worksheet") && zip!.has(rel.path)
          ? [
              {
                name: (sheet.getAttribute("name") ?? "").slice(0, 128),
                key: rel.path,
              },
            ]
          : [];
      })
      .slice(0, 100);
    if (!sheets.length) throw new Error("No spreadsheet sheets");
    return {
      kind: "workbook",
      units: sheets,
      image,
      load: async (index, activeSignal = signal) => {
        if (!sheets[index]) throw new Error("Invalid worksheet index");
        resetImages();
        const doc = await xml(sheets[index].key, activeSignal);
        return parseSpreadsheetSheet(doc!, strings, styles, date1904, locale);
      },
    };
  }
  if (zip?.has("ppt/presentation.xml")) {
    const [doc, relationship, theme] = await Promise.all([
      xml("ppt/presentation.xml", signal, true),
      relations("ppt/presentation.xml"),
      xml("ppt/theme/theme1.xml", signal, true),
    ]);
    const size = first(doc, N.presentation, "sldSz");
    const width = Math.max(
        280,
        number(size?.getAttribute("cx"), 9_144_000, 15_240_000) / 9525,
      ),
      height = Math.max(
        200,
        number(size?.getAttribute("cy"), 5_143_500, 15_240_000) / 9525,
      );
    const slides = descendants(doc, N.presentation, "sldId")
      .flatMap((item) => {
        const rel = relationship.get(attr(item, N.relationship, "id"));
        return rel?.type.endsWith("/slide") && zip!.has(rel.path)
          ? [{ name: "", key: rel.path }]
          : [];
      })
      .slice(0, 200);
    if (!slides.length) throw new Error("No presentation slides");
    return {
      kind: "presentation",
      units: slides,
      image,
      load: async (index, activeSignal = signal) => {
        resetImages();
        if (!slides[index]) throw new Error("Invalid slide index");
        const layer = async (path: string) => {
          const [doc, relationships] = await Promise.all([
            xml(path, activeSignal),
            relations(path, activeSignal),
          ]);
          return doc ? { doc, relationships } : undefined;
        };
        const slide = await layer(slides[index].key);
        if (!slide) throw new Error("Missing slide part");
        const layoutPart = [...slide.relationships.values()].find((rel) =>
          rel.type.endsWith("/slideLayout"),
        )?.path;
        const layout = layoutPart ? await layer(layoutPart) : undefined;
        const masterPart = [...(layout?.relationships.values() ?? [])].find(
          (rel) => rel.type.endsWith("/slideMaster"),
        )?.path;
        const master = masterPart ? await layer(masterPart) : undefined;
        const themePart = [...(master?.relationships.values() ?? [])].find(
          (rel) => rel.type.endsWith("/theme"),
        )?.path;
        const activeTheme = themePart
          ? await xml(themePart, activeSignal)
          : theme;
        return powerpointSlidePage(
          slide,
          layout,
          master,
          officeTheme(activeTheme),
          width,
          height,
        );
      },
    };
  }
  throw new Error("Unsupported Office package");
}
