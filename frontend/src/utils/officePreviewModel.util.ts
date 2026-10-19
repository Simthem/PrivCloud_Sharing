import type { CSSProperties } from "react";
import type { openPreviewZip } from "./officePreview.util";

export const OFFICE_NS = {
  word: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  sheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  presentation: "http://schemas.openxmlformats.org/presentationml/2006/main",
  relationship:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  package: "http://schemas.openxmlformats.org/package/2006/relationships",
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
  xlink: "http://www.w3.org/1999/xlink",
} as const;

export type PreviewZip = Awaited<ReturnType<typeof openPreviewZip>>;
export type OfficeRun = { text: string; style?: CSSProperties };
export type OfficeParagraph = {
  kind: "paragraph";
  runs: OfficeRun[];
  style?: CSSProperties;
  heading?: number;
  marker?: string;
  pageBreakBefore?: boolean;
};
export type OfficeImage = {
  kind: "image";
  path: string;
  width?: number;
  height?: number;
};
export type OfficeCell = {
  runs: OfficeRun[];
  style?: CSSProperties;
  colSpan?: number;
  rowSpan?: number;
  covered?: boolean;
  formula?: string;
};
export type OfficeTable = {
  kind: "table";
  rows: { cells: OfficeCell[]; height?: number; index?: number }[];
  widths?: number[];
  name?: string;
  grid?: boolean;
  columnOffset?: number;
};
export type OfficeBlock = OfficeParagraph | OfficeImage | OfficeTable;
export type OfficeShape = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  ellipse?: boolean;
  style?: CSSProperties;
  blocks: OfficeBlock[];
};
export type OfficePage = {
  blocks: OfficeBlock[];
  shapes?: OfficeShape[];
  width: number;
  height: number;
  padding?: number[];
  background?: string;
  truncated: boolean;
};
export type OfficeDocument = {
  kind: "document" | "workbook" | "presentation";
  units: { name: string; key: string }[];
  load: (_index: number, _signal?: AbortSignal) => Promise<OfficePage>;
  image: (_path: string, _signal?: AbortSignal) => Promise<Uint8Array | null>;
};

/** Limits apply to a rendered sheet/page, independently of total package size. */
export class OfficeBudget {
  chars = 1024 * 1024;
  cells = 20_000;
  nodes = 4000;
  images = 64;
  truncated = false;
  take(value: string, limit = 16_384) {
    const length = Math.max(0, Math.min(this.chars, limit));
    if (value.length > length) this.truncated = true;
    const text = value.slice(0, length);
    this.chars -= text.length;
    return text;
  }
}

export function parseOfficeXml(xml: string, parser: DOMParser): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Document entities are unsupported");
  let tags = 0;
  for (let i = 0; i < xml.length; i++) {
    if (xml[i] === "<" && ++tags > 150_000)
      throw new Error("Document complexity exceeds preview budget");
  }
  const doc = parser.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error("Invalid document XML");
  const stack: [Element, number][] = [[doc.documentElement, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (depth > 64) throw new Error("Document nesting exceeds preview budget");
    for (const child of Array.from(node.children))
      stack.push([child, depth + 1]);
  }
  return doc;
}

export function descendants(
  node: Element | Document | null | undefined,
  ns: string,
  name: string,
): Element[] {
  return node ? Array.from(node.getElementsByTagNameNS(ns, name)) : [];
}
export function first(
  node: Element | Document | null | undefined,
  ns: string,
  name: string,
): Element | undefined {
  return node?.getElementsByTagNameNS(ns, name)[0];
}
export function children(
  node: Element | null | undefined,
  ns: string,
  name: string,
): Element[] {
  return node
    ? Array.from(node.children).filter(
        (child) => child.namespaceURI === ns && child.localName === name,
      )
    : [];
}
export function attr(
  node: Element | null | undefined,
  ns: string,
  name: string,
): string {
  return node?.getAttributeNS(ns, name) ?? "";
}
export function number(
  value: string | null | undefined,
  fallback = 0,
  max = 16_384,
): number {
  if (!value?.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : fallback;
}
export function color(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^#/, "");
  if (/^[\da-f]{6}$/i.test(hex)) return "#" + hex;
  if (/^[\da-f]{8}$/i.test(hex)) return "#" + hex.slice(2);
  if (/^[\da-f]{3}$/i.test(hex)) return "#" + hex;
  return undefined;
}
export function font(value: string | null | undefined): string | undefined {
  if (value && value.length <= 128 && /^[\p{L}\p{N} ,_'"-]+$/u.test(value))
    return value;
  return undefined;
}
export function length(
  value: string | null | undefined,
  max = 1600,
): number | undefined {
  const match = value?.match(/^(-?\d+(?:\.\d+)?)\s*(cm|mm|in|pt|px)$/);
  if (!match) return undefined;
  const scale: Record<string, number> = {
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    in: 96,
    pt: 96 / 72,
    px: 1,
  };
  return Math.max(-max, Math.min(max, Number(match[1]) * scale[match[2]]));
}
export function alignment(value: string): CSSProperties["textAlign"] {
  return (
    {
      start: "left",
      end: "right",
      both: "justify",
      left: "left",
      right: "right",
      center: "center",
      justify: "justify",
    } as const
  )[value as "left"];
}

/** Package relationships never become network or filesystem URLs. */
export function resolveOfficePart(base: string, target: string): string | null {
  if (
    !target ||
    target.length > 1024 ||
    /[\\\u0000-\u001f]|^[a-z][a-z\d+.-]*:|^\/\//i.test(target)
  )
    return null;
  const path = target.split("#")[0];
  const parts = path.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || null;
}
export function relationshipPart(part: string): string {
  const pieces = part.split("/");
  return [...pieces.slice(0, -1), "_rels", pieces.at(-1) + ".rels"].join("/");
}
export type OfficeRelationship = { path: string; type: string };
export function parseOfficeRelationships(
  xml: Document,
  part: string,
): Map<string, OfficeRelationship> {
  const result = new Map<string, OfficeRelationship>();
  for (const rel of descendants(xml, OFFICE_NS.package, "Relationship")) {
    if (rel.getAttribute("TargetMode") === "External") continue;
    const path = resolveOfficePart(part, rel.getAttribute("Target") ?? "");
    const id = rel.getAttribute("Id");
    if (path && id && !result.has(id))
      result.set(id, { path, type: rel.getAttribute("Type") ?? "" });
  }
  return result;
}

/** Only bounded raster images are exposed to the browser image decoder. */
export function officeImageMime(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const allowed = (w: number, h: number) =>
    w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= 16_000_000;
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452
  ) {
    return allowed(view.getUint32(16), view.getUint32(20)) ? "image/png" : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < Math.min(bytes.length, 1024 * 1024)) {
      if (bytes[offset++] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset + 3 > bytes.length) return null;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        return allowed(view.getUint16(offset + 5), view.getUint16(offset + 3))
          ? "image/jpeg"
          : null;
      }
      offset += size;
    }
  }
  return null;
}
