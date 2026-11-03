import type { CSSProperties } from "react";
import { OFFICE_XML_MAX_BYTES, openPreviewZip } from "./officePreview.util";
import {
  OfficeBudget,
  officeImageMime,
  parseOfficeXml,
  resolveOfficePart,
  type OfficeBlock,
  type OfficeDocument,
  type OfficeRun,
} from "./officePreviewModel.util";
import type { PreviewByteSource } from "./previewRange.util";

const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";
const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const MAX_CHAPTERS = 2000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGES_MAX_BYTES = 32 * 1024 * 1024;

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "div",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "td",
  "th",
  "tr",
]);
const SKIPPED_TAGS = new Set(["head", "script", "style", "template", "title"]);
const INLINE_STYLES: Record<string, CSSProperties> = {
  b: { fontWeight: 700 },
  strong: { fontWeight: 700 },
  i: { fontStyle: "italic" },
  em: { fontStyle: "italic" },
  cite: { fontStyle: "italic" },
  u: { textDecoration: "underline" },
  s: { textDecoration: "line-through" },
  del: { textDecoration: "line-through" },
  code: { fontFamily: "monospace" },
  kbd: { fontFamily: "monospace" },
  sub: { verticalAlign: "sub", fontSize: "0.8em" },
  sup: { verticalAlign: "super", fontSize: "0.8em" },
};

/**
 * EPUB chapters are XHTML. A document type declaration without internal
 * subset is dropped (entities stay refused), and the one named entity books
 * commonly use is written as a number.
 */
function chapterXml(text: string): string {
  return text
    .replace(/^(﻿?\s*(?:<\?xml[^>]*\?>)?\s*)<!DOCTYPE[^>[]*>/i, "$1")
    .replace(/&nbsp;/g, "&#160;");
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function chapterBlocks(
  root: Element,
  chapter: string,
  budget: OfficeBudget,
): OfficeBlock[] {
  const blocks: OfficeBlock[] = [];
  let runs: OfficeRun[] = [];
  const flush = (heading?: number, preformatted = false) => {
    const text = runs.map((run) => run.text).join("");
    if (text.trim())
      blocks.push({
        kind: "paragraph",
        runs: preformatted
          ? runs
          : runs.map((run, index) => ({
              ...run,
              text: index ? run.text : run.text.trimStart(),
            })),
        heading,
        style: preformatted
          ? { whiteSpace: "pre-wrap", fontFamily: "monospace" }
          : undefined,
      });
    runs = [];
  };
  const image = (target: string | null) => {
    if (!target || budget.images <= 0) return;
    const path = resolveOfficePart(chapter, decodePath(target));
    if (!path) return;
    budget.images--;
    flush();
    blocks.push({ kind: "image", path });
  };
  const walk = (node: Element, style: CSSProperties, pre: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (budget.nodes-- <= 0) {
        budget.truncated = true;
        return;
      }
      if (child.nodeType === 3) {
        const value = pre
          ? (child.nodeValue ?? "")
          : (child.nodeValue ?? "").replace(/[ \t\n\r\f]+/g, " ");
        if (value) runs.push({ text: budget.take(value), style });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const tag = element.localName.toLowerCase();
      if (SKIPPED_TAGS.has(tag)) continue;
      if (tag === "img") {
        image(element.getAttribute("src"));
        continue;
      }
      if (tag === "image") {
        image(
          element.getAttribute("href") ??
            element.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
        );
        continue;
      }
      if (tag === "br") {
        flush(undefined, pre);
        continue;
      }
      const heading = /^h([1-6])$/.exec(tag);
      if (BLOCK_TAGS.has(tag)) {
        flush(undefined, pre);
        walk(element, style, pre || tag === "pre");
        flush(heading ? Number(heading[1]) : undefined, pre || tag === "pre");
        continue;
      }
      walk(element, { ...style, ...INLINE_STYLES[tag] }, pre);
    }
  };
  walk(root, {}, false);
  flush();
  return blocks;
}

/** Reads the package, its reading order, then one chapter at a time. */
export async function openEpubDocument(
  source: PreviewByteSource,
  signal: AbortSignal,
  parser: DOMParser,
): Promise<OfficeDocument> {
  const zip = await openPreviewZip(source, signal);
  const xml = async (path: string, activeSignal = signal) => {
    if (!zip.has(path)) throw new Error("Missing book part");
    const bytes = await zip.read(path, OFFICE_XML_MAX_BYTES, activeSignal);
    return parseOfficeXml(chapterXml(new TextDecoder().decode(bytes)), parser);
  };
  const container = await xml("META-INF/container.xml");
  const rootfile = Array.from(
    container.getElementsByTagNameNS(CONTAINER_NS, "rootfile"),
  ).find(
    (element) =>
      (element.getAttribute("media-type") ??
        "application/oebps-package+xml") === "application/oebps-package+xml",
  );
  const packagePath = resolveOfficePart(
    "",
    rootfile?.getAttribute("full-path") ?? "",
  );
  if (!packagePath) throw new Error("Missing book package");
  const pack = await xml(packagePath);
  const manifest = new Map<string, { path: string; type: string }>();
  for (const item of Array.from(pack.getElementsByTagNameNS(OPF_NS, "item"))) {
    const path = resolveOfficePart(
      packagePath,
      decodePath(item.getAttribute("href") ?? ""),
    );
    if (path)
      manifest.set(item.getAttribute("id") ?? "", {
        path,
        type: item.getAttribute("media-type") ?? "",
      });
  }
  const chapters = Array.from(pack.getElementsByTagNameNS(OPF_NS, "itemref"))
    .map((reference) => manifest.get(reference.getAttribute("idref") ?? ""))
    .filter(
      (item): item is { path: string; type: string } =>
        !!item &&
        /^application\/xhtml\+xml$|^text\/html$/i.test(item.type) &&
        zip.has(item.path),
    )
    .slice(0, MAX_CHAPTERS);
  if (!chapters.length) throw new Error("Book has no readable chapter");
  const title =
    pack
      .getElementsByTagNameNS(DC_NS, "title")[0]
      ?.textContent?.trim()
      .slice(0, 128) ?? "";
  let imageBytes = 0;
  return {
    kind: "document",
    units: chapters.map((chapter, index) => ({
      name:
        index === 0 && title
          ? title
          : (chapter.path.split("/").pop() ?? "").slice(0, 128),
      key: String(index),
    })),
    load: async (index, activeSignal = signal) => {
      const chapter = chapters[index];
      if (!chapter) throw new Error("Unknown chapter");
      const doc = await xml(chapter.path, activeSignal);
      const body =
        Array.from(doc.getElementsByTagName("*")).find(
          (element) => element.localName === "body",
        ) ?? doc.documentElement;
      const budget = new OfficeBudget();
      // Chapters are long runs of small text nodes.
      budget.nodes = 50_000;
      imageBytes = 0;
      const blocks = chapterBlocks(body, chapter.path, budget);
      return {
        blocks,
        width: 794,
        height: 1123,
        padding: [48, 56, 48, 56],
        truncated: budget.truncated,
      };
    },
    image: async (path, activeSignal = signal) => {
      signal.throwIfAborted();
      activeSignal.throwIfAborted();
      if (!zip.has(path)) return null;
      const expanded = zip.expandedSize(path) ?? 0;
      if (
        expanded > IMAGE_MAX_BYTES ||
        imageBytes + expanded > IMAGES_MAX_BYTES
      )
        return null;
      imageBytes += expanded;
      const bytes = await zip.read(path, IMAGE_MAX_BYTES, activeSignal);
      return officeImageMime(bytes) ? bytes : null;
    },
  };
}
