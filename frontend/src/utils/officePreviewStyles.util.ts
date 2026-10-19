import type { CSSProperties } from "react";
import {
  OFFICE_NS as N,
  alignment,
  attr,
  children,
  color,
  descendants,
  first,
  font,
  length,
  number,
} from "./officePreviewModel.util";

export type OfficeStyle = {
  text: CSSProperties;
  paragraph: CSSProperties;
  heading?: number;
};
const empty = (): OfficeStyle => ({ text: {}, paragraph: {} });
const combine = (a: OfficeStyle, b: OfficeStyle): OfficeStyle => ({
  text: { ...a.text, ...b.text },
  paragraph: { ...a.paragraph, ...b.paragraph },
  heading: b.heading ?? a.heading,
});

function odfProperties(node: Element, fonts: Map<string, string>): OfficeStyle {
  const result = empty();
  for (const p of Array.from(node.children)) {
    if (p.namespaceURI !== N.style) continue;
    const target =
      p.localName === "text-properties" ? result.text : result.paragraph;
    const size = length(attr(p, N.fo, "font-size"), 160);
    const foreground = color(attr(p, N.fo, "color"));
    const background = color(attr(p, N.fo, "background-color"));
    const face =
      font(attr(p, N.fo, "font-family")) ??
      fonts.get(attr(p, N.style, "font-name"));
    if (size && size > 0) target.fontSize = size;
    if (face) target.fontFamily = face;
    if (foreground) target.color = foreground;
    if (background) target.backgroundColor = background;
    const weight = attr(p, N.fo, "font-weight");
    if (weight)
      target.fontWeight =
        weight === "bold" || Number(weight) >= 600 ? 700 : 400;
    if (attr(p, N.fo, "font-style"))
      target.fontStyle =
        attr(p, N.fo, "font-style") === "italic" ? "italic" : "normal";
    const decorations = [];
    if (
      attr(p, N.style, "text-underline-style") &&
      attr(p, N.style, "text-underline-style") !== "none"
    )
      decorations.push("underline");
    if (
      attr(p, N.style, "text-line-through-style") &&
      attr(p, N.style, "text-line-through-style") !== "none"
    )
      decorations.push("line-through");
    if (decorations.length) target.textDecoration = decorations.join(" ");
    const align = alignment(attr(p, N.fo, "text-align"));
    if (align) target.textAlign = align;
    const vertical = attr(p, N.style, "vertical-align");
    if (["top", "middle", "bottom"].includes(vertical))
      target.verticalAlign = vertical as "top";
    const position = attr(p, N.style, "text-position");
    if (position.startsWith("super")) {
      target.verticalAlign = "super";
      target.fontSize = "0.75em";
    }
    if (position.startsWith("sub")) {
      target.verticalAlign = "sub";
      target.fontSize = "0.75em";
    }
    const pairs = [
      ["margin-left", "marginLeft"],
      ["margin-right", "marginRight"],
      ["margin-top", "marginTop"],
      ["margin-bottom", "marginBottom"],
      ["text-indent", "textIndent"],
      ["padding", "padding"],
    ] as const;
    for (const [key, css] of pairs) {
      const value = length(attr(p, N.fo, key), 320);
      if (value !== undefined) target[css] = value;
    }
    const line = attr(p, N.fo, "line-height");
    if (/^\d+(?:\.\d+)?%$/.test(line))
      target.lineHeight = Math.min(4, Number(line.slice(0, -1)) / 100);
    const linePx = length(line, 240);
    if (linePx && linePx > 0) target.lineHeight = linePx + "px";
    for (const [key, css] of [
      ["border", "border"],
      ["border-top", "borderTop"],
      ["border-bottom", "borderBottom"],
      ["border-left", "borderLeft"],
      ["border-right", "borderRight"],
    ] as const) {
      const parts = attr(p, N.fo, key).split(/\s+/);
      const width = length(parts[0], 8);
      const shade = color(parts[2]);
      if (
        width !== undefined &&
        ["solid", "dashed", "dotted", "double"].includes(parts[1]) &&
        shade
      )
        target[css] = `${width}px ${parts[1]} ${shade}`;
    }
    if (attr(p, N.fo, "break-before") === "page") target.breakBefore = "page";
    if (attr(p, N.fo, "wrap-option") === "wrap") target.whiteSpace = "pre-wrap";
  }
  return result;
}

export function odfStyles(documents: Document[]) {
  const fonts = new Map<string, string>();
  const styles = new Map<string, Element>();
  for (const doc of documents) {
    for (const face of descendants(doc, N.style, "font-face")) {
      const value = font(attr(face, N.svg, "font-family"));
      if (value) fonts.set(attr(face, N.style, "name"), value);
    }
    for (const node of [
      ...descendants(doc, N.style, "default-style"),
      ...descendants(doc, N.style, "style"),
    ]) {
      const family = attr(node, N.style, "family");
      const name =
        node.localName === "default-style" ? "" : attr(node, N.style, "name");
      styles.set(family + ":" + name, node);
    }
  }
  const cache = new Map<string, OfficeStyle>();
  const resolve = (family: string, name = "", depth = 0): OfficeStyle => {
    if (depth > 16) return empty();
    const key = family + ":" + name;
    const cached = cache.get(key);
    if (cached) return cached;
    const node = styles.get(key);
    const parent = node && attr(node, N.style, "parent-style-name");
    const base = parent
      ? resolve(family, parent, depth + 1)
      : name
        ? resolve(family, "", depth + 1)
        : empty();
    const value = node ? combine(base, odfProperties(node, fonts)) : base;
    cache.set(key, value);
    return value;
  };
  return {
    resolve,
    node: (family: string, name: string) => styles.get(family + ":" + name),
    styleFor: (node: Element, family: string) =>
      resolve(
        family,
        attr(node, N.text, "style-name") ||
          attr(node, N.table, "style-name") ||
          attr(node, N.draw, "style-name"),
      ),
  };
}

function wordEnabled(node: Element | undefined): boolean | undefined {
  if (!node) return undefined;
  return !["0", "false", "off"].includes(attr(node, N.word, "val"));
}
export function wordTextStyle(
  properties: Element | undefined,
  palette: Record<string, string> = {},
): CSSProperties {
  const result: CSSProperties = {};
  if (!properties) return result;
  const bold = wordEnabled(first(properties, N.word, "b"));
  const italic = wordEnabled(first(properties, N.word, "i"));
  if (bold !== undefined) result.fontWeight = bold ? 700 : 400;
  if (italic !== undefined) result.fontStyle = italic ? "italic" : "normal";
  const decorations = [];
  const underline = first(properties, N.word, "u");
  if (
    underline &&
    !["none", "0", "false"].includes(attr(underline, N.word, "val"))
  )
    decorations.push("underline");
  if (wordEnabled(first(properties, N.word, "strike")))
    decorations.push("line-through");
  if (decorations.length) result.textDecoration = decorations.join(" ");
  const size =
    (number(attr(first(properties, N.word, "sz"), N.word, "val")) * 2) / 3;
  if (size > 0) result.fontSize = Math.min(160, size);
  const faces = first(properties, N.word, "rFonts");
  const face = font(
    attr(faces, N.word, "ascii") || attr(faces, N.word, "hAnsi"),
  );
  if (face) result.fontFamily = face;
  const foreground = first(properties, N.word, "color");
  const shade =
    color(attr(foreground, N.word, "val")) ??
    palette[attr(foreground, N.word, "themeColor")];
  if (shade) result.color = shade;
  const fill = color(attr(first(properties, N.word, "shd"), N.word, "fill"));
  if (fill) result.backgroundColor = fill;
  const highlight = attr(first(properties, N.word, "highlight"), N.word, "val");
  const highlights: Record<string, string> = {
    yellow: "#ffff00",
    green: "#00ff00",
    cyan: "#00ffff",
    magenta: "#ff00ff",
    blue: "#0000ff",
    red: "#ff0000",
    darkYellow: "#808000",
    lightGray: "#dddddd",
  };
  if (highlights[highlight]) result.backgroundColor = highlights[highlight];
  const vertical = attr(first(properties, N.word, "vertAlign"), N.word, "val");
  if (vertical === "superscript" || vertical === "subscript") {
    result.verticalAlign = vertical === "superscript" ? "super" : "sub";
    result.fontSize = "0.75em";
  }
  return result;
}
export function wordParagraphStyle(
  properties: Element | undefined,
): CSSProperties {
  if (!properties) return {};
  const result: CSSProperties = {};
  const align = alignment(attr(first(properties, N.word, "jc"), N.word, "val"));
  if (align) result.textAlign = align;
  const space = first(properties, N.word, "spacing");
  for (const [key, css] of [
    ["before", "marginTop"],
    ["after", "marginBottom"],
  ] as const) {
    const value = attr(space, N.word, key);
    if (value) result[css] = Math.max(0, number(value) / 15);
  }
  const line = attr(space, N.word, "line");
  if (line)
    result.lineHeight =
      attr(space, N.word, "lineRule") === "exact"
        ? `${Math.max(1, number(line) / 15)}px`
        : Math.max(0.5, Math.min(4, number(line) / 240));
  const indent = first(properties, N.word, "ind");
  for (const [key, css] of [
    ["left", "marginLeft"],
    ["right", "marginRight"],
    ["firstLine", "textIndent"],
  ] as const) {
    const value = attr(indent, N.word, key);
    if (value) result[css] = number(value, 0, 4800) / 15;
  }
  if (attr(indent, N.word, "hanging"))
    result.textIndent = -number(attr(indent, N.word, "hanging"), 0, 2400) / 15;
  return result;
}
export function wordStyles(
  doc?: Document,
  palette: Record<string, string> = {},
) {
  const map = new Map<string, Element>();
  for (const node of descendants(doc, N.word, "style"))
    map.set(attr(node, N.word, "styleId"), node);
  const defaults = {
    text: wordTextStyle(
      first(first(doc, N.word, "rPrDefault"), N.word, "rPr"),
      palette,
    ),
    paragraph: wordParagraphStyle(
      first(first(doc, N.word, "pPrDefault"), N.word, "pPr"),
    ),
  };
  const resolve = (id: string, depth = 0): OfficeStyle => {
    if (depth > 16) return defaults;
    const node = map.get(id);
    if (!node) return defaults;
    const parent = attr(first(node, N.word, "basedOn"), N.word, "val");
    const base = parent ? resolve(parent, depth + 1) : defaults;
    const name = attr(first(node, N.word, "name"), N.word, "val") || id;
    const heading = name.match(/^heading\s*([1-6])$/i);
    return combine(base, {
      text: wordTextStyle(children(node, N.word, "rPr")[0], palette),
      paragraph: wordParagraphStyle(children(node, N.word, "pPr")[0]),
      heading: heading ? Number(heading[1]) : undefined,
    });
  };
  return { resolve, defaults };
}

export function officeTheme(doc?: Document): Record<string, string> {
  const palette: Record<string, string> = {};
  for (const node of Array.from(
    first(doc, N.drawing, "clrScheme")?.children ?? [],
  )) {
    const item = node.children[0];
    const value =
      color(item?.getAttribute("val")) ?? color(item?.getAttribute("lastClr"));
    if (value) palette[node.localName] = value;
  }
  palette.tx1 = palette.dk1 ?? "#000000";
  palette.tx2 = palette.dk2 ?? "#333333";
  palette.bg1 = palette.lt1 ?? "#ffffff";
  palette.bg2 = palette.lt2 ?? "#eeeeee";
  palette.text1 = palette.tx1;
  palette.text2 = palette.tx2;
  palette.background1 = palette.bg1;
  palette.background2 = palette.bg2;
  return palette;
}
export function drawingColor(
  node: Element | undefined,
  palette: Record<string, string>,
): string | undefined {
  const value = first(node, N.drawing, "srgbClr");
  if (value) return color(value.getAttribute("val"));
  const scheme = first(node, N.drawing, "schemeClr")?.getAttribute("val");
  return scheme ? palette[scheme] : undefined;
}
export function drawingTextStyle(
  properties: Element | undefined,
  palette: Record<string, string>,
): CSSProperties {
  if (!properties) return {};
  const result: CSSProperties = {};
  const b = properties.getAttribute("b"),
    i = properties.getAttribute("i");
  if (b !== null) result.fontWeight = b === "1" ? 700 : 400;
  if (i !== null) result.fontStyle = i === "1" ? "italic" : "normal";
  if (properties.getAttribute("u") && properties.getAttribute("u") !== "none")
    result.textDecoration = "underline";
  const size = number(properties.getAttribute("sz")) / 75;
  if (size > 0) result.fontSize = Math.min(160, size);
  const fill = drawingColor(first(properties, N.drawing, "solidFill"), palette);
  if (fill) result.color = fill;
  const face = font(
    first(properties, N.drawing, "latin")?.getAttribute("typeface"),
  );
  if (face && !face.startsWith("+")) result.fontFamily = face;
  return result;
}
