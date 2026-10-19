import { Inflate } from "fflate";
import { readPreviewBytes, type PreviewByteSource } from "./previewRange.util";

export const OFFICE_XML_MAX_BYTES = 16 * 1024 * 1024;
const OFFICE_COMPRESSED_MAX_BYTES = 8 * 1024 * 1024;
const ZIP_DIRECTORY_MAX_BYTES = 2 * 1024 * 1024;
type ZipEntry = {
  offset: number;
  compressed: number;
  expanded: number;
  method: number;
};

/** Read a ZIP directory and individual entries without downloading embedded media. */
export async function openPreviewZip(
  source: PreviewByteSource,
  signal: AbortSignal,
) {
  const tailStart = Math.max(0, source.size - 65_557);
  const tail = await readPreviewBytes(source, tailStart, source.size, signal);
  const view = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid document package");
  const count = view.getUint16(eocd + 10, true);
  const length = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    count !== view.getUint16(eocd + 8, true) ||
    count === 0xffff ||
    length > ZIP_DIRECTORY_MAX_BYTES ||
    offset + length > tailStart + eocd
  )
    throw new Error("Unsupported document package layout");
  const directory = await readPreviewBytes(
    source,
    offset,
    offset + length,
    signal,
  );
  const entries = new Map<string, ZipEntry>();
  const central = new DataView(directory.buffer);
  let pos = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > length || central.getUint32(pos, true) !== 0x02014b50)
      throw new Error("Invalid document directory");
    const flags = central.getUint16(pos + 8, true);
    const nameLength = central.getUint16(pos + 28, true);
    const entryLength =
      46 +
      nameLength +
      central.getUint16(pos + 30, true) +
      central.getUint16(pos + 32, true);
    if (pos + entryLength > length) throw new Error("Invalid document entry");
    const name = new TextDecoder().decode(
      directory.subarray(pos + 46, pos + 46 + nameLength),
    );
    if (flags & 1 || entries.has(name))
      throw new Error("Encrypted or duplicate document entry");
    entries.set(name, {
      method: central.getUint16(pos + 10, true),
      compressed: central.getUint32(pos + 20, true),
      expanded: central.getUint32(pos + 24, true),
      offset: central.getUint32(pos + 42, true),
    });
    pos += entryLength;
  }
  return {
    has: (name: string) => entries.has(name),
    names: () => Array.from(entries.keys()),
    expandedSize: (name: string) => entries.get(name)?.expanded,
    async read(
      name: string,
      maxBytes = OFFICE_XML_MAX_BYTES,
      readSignal = signal,
    ) {
      const entry = entries.get(name);
      if (
        !entry ||
        entry.expanded > maxBytes ||
        entry.compressed > OFFICE_COMPRESSED_MAX_BYTES ||
        ![0, 8].includes(entry.method) ||
        entry.offset + 30 > offset
      )
        throw new Error(
          "Document entry exceeds preview budget or is unsupported",
        );
      const header = await readPreviewBytes(
        source,
        entry.offset,
        entry.offset + 30,
        readSignal,
      );
      const local = new DataView(header.buffer);
      if (
        local.getUint32(0, true) !== 0x04034b50 ||
        local.getUint16(8, true) !== entry.method ||
        local.getUint16(6, true) & 1
      )
        throw new Error("Invalid document local header");
      const dataStart =
        entry.offset +
        30 +
        local.getUint16(26, true) +
        local.getUint16(28, true);
      if (dataStart + entry.compressed > offset)
        throw new Error("Invalid document entry bounds");
      const compressed = await readPreviewBytes(
        source,
        dataStart,
        dataStart + entry.compressed,
        readSignal,
      );
      if (entry.method === 0) {
        if (compressed.length !== entry.expanded)
          throw new Error("Invalid stored document entry");
        return compressed;
      }
      // Stream inflate and stop if the actual output exceeds its declared size.
      // Never trust ZIP size fields enough to let inflateSync allocate freely.
      const result = new Uint8Array(entry.expanded);
      let written = 0;
      const inflate = new Inflate((bytes) => {
        if (written + bytes.length > result.length)
          throw new Error("Document decompression exceeds preview budget");
        result.set(bytes, written);
        written += bytes.length;
      });
      for (let i = 0; i < compressed.length; i += 4096) {
        readSignal.throwIfAborted();
        inflate.push(
          compressed.subarray(i, i + 4096),
          i + 4096 >= compressed.length,
        );
      }
      if (written !== entry.expanded)
        throw new Error("Incomplete document entry");
      return result;
    },
  };
}

export type OfficeBlock = {
  kind: "heading" | "paragraph" | "table" | "slide";
  text?: string;
  rows?: string[][];
};
const ODF_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const ODF_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const ODF_DRAW = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Parse only document content. Scripts, HTML, external resources and formulas
 * are never inserted or evaluated. The renderer uses React text nodes. */
export function parseOfficeContent(
  xml: string,
  parser: DOMParser,
): { blocks: OfficeBlock[]; truncated: boolean } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Document entities are unsupported");
  let tagCount = 0;
  for (let i = 0; i < xml.length; i++) {
    if (xml[i] === "<" && ++tagCount > 100_000)
      throw new Error("Document XML exceeds preview complexity budget");
  }
  const doc = parser.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error("Invalid document XML");
  const blocks: OfficeBlock[] = [];
  let remainingChars = 1024 * 1024;
  let truncated = false;
  let remainingCells = 10_000;
  let visited = 0;
  const contentText = (node: Node, depth = 0): string => {
    if (depth > 64) {
      truncated = true;
      return "";
    }
    if (node.nodeType === 3) return node.textContent || "";
    const element = node as Element;
    if (element.namespaceURI === ODF_TEXT && element.localName === "s")
      return " ".repeat(
        Math.min(
          1024,
          Math.max(1, Number(element.getAttributeNS(ODF_TEXT, "c")) || 1),
        ),
      );
    if (
      (element.namespaceURI === ODF_TEXT &&
        ["tab", "line-break"].includes(element.localName)) ||
      (element.namespaceURI === WORD &&
        ["tab", "br"].includes(element.localName))
    )
      return element.localName === "tab" ? "\t" : "\n";
    return Array.from(node.childNodes)
      .map((child) => contentText(child, depth + 1))
      .join("");
  };
  const text = (node: Element, limit = remainingChars) => {
    let value = contentText(node);
    if (value.length > limit) {
      value = value.slice(0, limit);
      truncated = true;
    }
    if (value.length > remainingChars) {
      value = value.slice(0, remainingChars);
      truncated = true;
    }
    remainingChars -= value.length;
    return value;
  };
  const visit = (node: Element, depth: number) => {
    if (
      blocks.length >= 2000 ||
      remainingChars <= 0 ||
      depth > 64 ||
      ++visited > 50_000
    ) {
      truncated = true;
      return;
    }
    const ns = node.namespaceURI;
    const name = node.localName;
    if (
      (ns === ODF_TEXT && ["p", "h"].includes(name)) ||
      (ns === WORD && name === "p")
    ) {
      blocks.push({
        kind: name === "h" ? "heading" : "paragraph",
        text: text(node),
      });
      return;
    }
    if (
      (ns === ODF_TABLE && name === "table") ||
      (ns === WORD && name === "tbl")
    ) {
      const rowName = ns === WORD ? "tr" : "table-row";
      const cellNames =
        ns === WORD ? ["tc"] : ["table-cell", "covered-table-cell"];
      const allRows = node.getElementsByTagNameNS(ns, rowName);
      const rows: string[][] = [];
      for (
        let i = 0;
        i < allRows.length &&
        rows.length < 200 &&
        remainingChars > 0 &&
        remainingCells > 0;
        i++
      ) {
        const row = allRows[i];
        const cells: string[] = [];
        for (const cell of Array.from(row.children).filter(
          (c) => c.namespaceURI === ns && cellNames.includes(c.localName),
        )) {
          const repeats = Math.min(
            50,
            Math.max(
              1,
              Number(
                cell.getAttributeNS(ODF_TABLE, "number-columns-repeated"),
              ) || 1,
            ),
          );
          const value = text(cell, Math.min(4096, remainingChars));
          for (
            let n = 0;
            n < repeats && cells.length < 50 && remainingChars > 0;
            n++
          ) {
            const copy = value.slice(0, remainingChars);
            cells.push(copy);
            if (n > 0) remainingChars -= copy.length;
          }
          if (cells.length >= 50) {
            truncated = true;
            break;
          }
        }
        const repeats = Math.min(
          200,
          Math.max(
            1,
            Number(row.getAttributeNS(ODF_TABLE, "number-rows-repeated")) || 1,
          ),
        );
        const actualRepeats =
          Number(row.getAttributeNS(ODF_TABLE, "number-rows-repeated")) || 1;
        if (actualRepeats > repeats) truncated = true;
        const rowChars = cells.reduce(
          (total, value) => total + value.length,
          0,
        );
        for (
          let n = 0;
          n < repeats &&
          rows.length < 200 &&
          remainingCells >= Math.max(1, cells.length) &&
          remainingChars > 0;
          n++
        ) {
          if (n > 0 && rowChars > remainingChars) {
            truncated = true;
            break;
          }
          rows.push(cells);
          remainingCells -= Math.max(1, cells.length);
          if (n > 0) remainingChars -= rowChars;
        }
        if (remainingCells <= 0) truncated = true;
      }
      if (allRows.length > rows.length) truncated = true;
      blocks.push({
        kind: "table",
        text: node.getAttributeNS(ODF_TABLE, "name") || "",
        rows,
      });
      return;
    }
    if (ns === ODF_DRAW && name === "page")
      blocks.push({
        kind: "slide",
        text: node.getAttributeNS(ODF_DRAW, "name") || "",
      });
    // Ignore embedded objects, scripts, binary payloads and metadata.
    if (["scripts", "binary-data", "object", "object-ole"].includes(name))
      return;
    for (const child of Array.from(node.children)) visit(child, depth + 1);
  };
  visit(doc.documentElement, 0);
  return { blocks, truncated };
}
