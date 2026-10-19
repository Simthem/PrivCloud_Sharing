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
  type OfficePage,
  type OfficeParagraph,
  type OfficeRelationship,
  type OfficeShape,
} from "./officePreviewModel.util";
import {
  odfStyles,
  drawingColor,
  drawingTextStyle,
} from "./officePreviewStyles.util";
import { parseOdfDocument, odfTable } from "./documentPreview.util";

type SlideLayer = {
  doc: Document;
  relationships: Map<string, OfficeRelationship>;
};
function placeholder(node: Element): string | undefined {
  const ph = first(node, N.presentation, "ph");
  return ph
    ? (ph.getAttribute("idx") ?? ph.getAttribute("type") ?? "body")
    : undefined;
}
function placeholderKind(node: Element): string {
  return first(node, N.presentation, "ph")?.getAttribute("type") ?? "body";
}
function slideParagraphs(
  shape: Element,
  inherited: Element | undefined,
  master: Document | undefined,
  palette: Record<string, string>,
  budget: OfficeBudget,
): OfficeParagraph[] {
  const body = first(shape, N.presentation, "txBody");
  const list =
    first(body, N.drawing, "lstStyle") ??
    first(inherited, N.drawing, "lstStyle");
  const kind = placeholderKind(shape);
  const masterStyle = first(
    master,
    N.presentation,
    ["title", "ctrTitle"].includes(kind)
      ? "titleStyle"
      : kind === "body"
        ? "bodyStyle"
        : "otherStyle",
  );
  return children(body, N.drawing, "p")
    .slice(0, 200)
    .map((p) => {
      const pPr = children(p, N.drawing, "pPr")[0];
      const level = Math.max(0, number(pPr?.getAttribute("lvl"), 0, 8));
      const defaults =
        first(list, N.drawing, `lvl${level + 1}pPr`) ??
        first(masterStyle, N.drawing, `lvl${level + 1}pPr`);
      const base = {
        ...drawingTextStyle(first(defaults, N.drawing, "defRPr"), palette),
        ...drawingTextStyle(first(pPr, N.drawing, "defRPr"), palette),
      };
      const alignments: Record<string, CSSProperties["textAlign"]> = {
        l: "left",
        r: "right",
        ctr: "center",
        just: "justify",
      };
      const style: CSSProperties = {
        textAlign:
          alignments[
            pPr?.getAttribute("algn") ?? defaults?.getAttribute("algn") ?? "l"
          ],
        margin: 0,
      };
      if (pPr?.hasAttribute("marL"))
        style.marginLeft =
          number(pPr.getAttribute("marL"), 0, 3_048_000) / 9525;
      const runs = Array.from(p.children).flatMap((run) => {
        if (run.namespaceURI !== N.drawing) return [];
        if (run.localName === "br") return [{ text: "\n", style: base }];
        if (!["r", "fld"].includes(run.localName)) return [];
        return [
          {
            text: budget.take(first(run, N.drawing, "t")?.textContent ?? ""),
            style: {
              ...base,
              ...drawingTextStyle(children(run, N.drawing, "rPr")[0], palette),
            },
          },
        ];
      });
      const bullet =
        first(pPr, N.drawing, "buChar") ?? first(defaults, N.drawing, "buChar");
      return {
        kind: "paragraph",
        runs,
        style,
        marker:
          bullet && !first(pPr, N.drawing, "buNone")
            ? (bullet.getAttribute("char") ?? "•").slice(0, 2)
            : undefined,
      };
    });
}

export function powerpointSlidePage(
  slide: SlideLayer,
  layout: SlideLayer | undefined,
  master: SlideLayer | undefined,
  palette: Record<string, string>,
  width: number,
  height: number,
): OfficePage {
  const budget = new OfficeBudget();
  const shapes: OfficeShape[] = [];
  const placeholders = new Map<string, Element>();
  for (const layer of [master, layout]) {
    for (const node of descendants(layer?.doc, N.presentation, "sp")) {
      const key = placeholder(node);
      if (key) placeholders.set(key, node);
    }
  }
  const visit = (
    node: Element,
    relationships: Map<string, OfficeRelationship>,
    background: boolean,
    transform = { x: 0, y: 0, sx: 1, sy: 1 },
    depth = 0,
  ) => {
    if (budget.nodes-- <= 0 || depth > 16 || shapes.length >= 1000) {
      budget.truncated = true;
      return;
    }
    if (node.namespaceURI !== N.presentation) return;
    if (node.localName === "grpSp") {
      const xfrm = first(
        children(node, N.presentation, "grpSpPr")[0],
        N.drawing,
        "xfrm",
      );
      const off = first(xfrm, N.drawing, "off"),
        ext = first(xfrm, N.drawing, "ext"),
        chOff = first(xfrm, N.drawing, "chOff"),
        chExt = first(xfrm, N.drawing, "chExt");
      const raw = (n: Element | undefined, key: string, fallback = 0) =>
        number(n?.getAttribute(key), fallback, 500_000_000);
      const sx = raw(ext, "cx", 1) / Math.max(1, raw(chExt, "cx", 1)),
        sy = raw(ext, "cy", 1) / Math.max(1, raw(chExt, "cy", 1));
      const next = {
        x:
          transform.x +
          ((raw(off, "x") - raw(chOff, "x") * sx) / 9525) * transform.sx,
        y:
          transform.y +
          ((raw(off, "y") - raw(chOff, "y") * sy) / 9525) * transform.sy,
        sx: Math.max(0.01, Math.min(100, transform.sx * sx)),
        sy: Math.max(0.01, Math.min(100, transform.sy * sy)),
      };
      for (const child of Array.from(node.children))
        visit(child, relationships, background, next, depth + 1);
      return;
    }
    if (!["sp", "pic", "graphicFrame"].includes(node.localName)) return;
    const key = placeholder(node);
    if (background && key) return;
    const inherited = key ? placeholders.get(key) : undefined;
    const xfrm =
      first(node, N.drawing, "xfrm") ??
      children(node, N.presentation, "xfrm")[0] ??
      first(inherited, N.drawing, "xfrm");
    const off = first(xfrm, N.drawing, "off"),
      ext = first(xfrm, N.drawing, "ext");
    const x =
      transform.x +
      (number(off?.getAttribute("x"), 0, 500_000_000) / 9525) * transform.sx;
    const y =
      transform.y +
      (number(off?.getAttribute("y"), 0, 500_000_000) / 9525) * transform.sy;
    const w = xfrm
      ? (number(ext?.getAttribute("cx"), 0, 500_000_000) / 9525) * transform.sx
      : width * 0.8;
    const h = xfrm
      ? (number(ext?.getAttribute("cy"), 0, 500_000_000) / 9525) * transform.sy
      : height * 0.2;
    const properties = children(node, N.presentation, "spPr")[0];
    const fill = drawingColor(
      children(properties, N.drawing, "solidFill")[0],
      palette,
    );
    const line = children(properties, N.drawing, "ln")[0];
    const border = drawingColor(first(line, N.drawing, "solidFill"), palette);
    const style: CSSProperties = {
      ...(fill ? { backgroundColor: fill } : {}),
      ...(border
        ? {
            border: `${Math.max(1, number(line?.getAttribute("w"), 9525, 95250) / 9525)}px solid ${border}`,
          }
        : {}),
    };
    const bodyPr =
      first(node, N.drawing, "bodyPr") ?? first(inherited, N.drawing, "bodyPr");
    style.padding = ["tIns", "rIns", "bIns", "lIns"]
      .map((key) =>
        Math.max(
          0,
          number(bodyPr?.getAttribute(key), 45_720, 1_000_000) / 9525,
        ),
      )
      .map((n) => n + "px")
      .join(" ");
    style.display = "flex";
    style.flexDirection = "column";
    style.justifyContent =
      bodyPr?.getAttribute("anchor") === "ctr"
        ? "center"
        : bodyPr?.getAttribute("anchor") === "b"
          ? "flex-end"
          : "flex-start";
    const blocks: OfficeBlock[] = slideParagraphs(
      node,
      inherited,
      master?.doc,
      palette,
      budget,
    );
    const image = first(node, N.drawing, "blip");
    const path =
      image && relationships.get(attr(image, N.relationship, "embed"))?.path;
    if (path && budget.images > 0) {
      budget.images--;
      blocks.push({ kind: "image", path, width: w, height: h });
    } else if (path) budget.truncated = true;
    const table = first(node, N.drawing, "tbl");
    if (table && budget.cells <= 0) budget.truncated = true;
    if (table && budget.cells > 0) {
      const rows = children(table, N.drawing, "tr")
        .slice(0, 200)
        .filter(() => {
          if (budget.cells <= 0) {
            budget.truncated = true;
            return false;
          }
          return true;
        })
        .map((row) => ({
          cells: children(row, N.drawing, "tc")
            .slice(0, Math.min(50, budget.cells))
            .map((cell) => {
              budget.cells--;
              const runs = descendants(cell, N.drawing, "r")
                .slice(0, 256)
                .map((run) => ({
                  text: budget.take(
                    first(run, N.drawing, "t")?.textContent ?? "",
                  ),
                  style: drawingTextStyle(
                    first(run, N.drawing, "rPr"),
                    palette,
                  ),
                }));
              const fill = drawingColor(
                first(first(cell, N.drawing, "tcPr"), N.drawing, "solidFill"),
                palette,
              );
              return {
                runs,
                style: fill ? { backgroundColor: fill } : {},
                colSpan: Math.max(
                  1,
                  number(cell.getAttribute("gridSpan"), 1, 50),
                ),
                rowSpan: Math.max(
                  1,
                  number(cell.getAttribute("rowSpan"), 1, 200),
                ),
                covered:
                  cell.getAttribute("hMerge") === "1" ||
                  cell.getAttribute("vMerge") === "1",
              };
            }),
        }));
      blocks.push({ kind: "table", rows });
    }
    shapes.push({
      x: Math.max(-width, Math.min(width * 2, x)),
      y: Math.max(-height, Math.min(height * 2, y)),
      width: Math.max(1, Math.min(width * 2, w)),
      height: Math.max(1, Math.min(height * 2, h)),
      rotation: number(xfrm?.getAttribute("rot"), 0, 21_600_000) / 60_000,
      ellipse:
        first(properties, N.drawing, "prstGeom")?.getAttribute("prst") ===
        "ellipse",
      style,
      blocks,
    });
  };
  for (const [layer, background] of [
    [master, true],
    [layout, true],
    [slide, false],
  ] as const) {
    if (!layer) continue;
    for (const node of Array.from(
      first(layer.doc, N.presentation, "spTree")?.children ?? [],
    ))
      visit(node, layer.relationships, background);
  }
  const background =
    drawingColor(
      first(first(slide.doc, N.presentation, "bg"), N.drawing, "solidFill"),
      palette,
    ) ??
    drawingColor(
      first(first(layout?.doc, N.presentation, "bg"), N.drawing, "solidFill"),
      palette,
    ) ??
    drawingColor(
      first(first(master?.doc, N.presentation, "bg"), N.drawing, "solidFill"),
      palette,
    ) ??
    "#ffffff";
  return {
    blocks: [],
    shapes,
    width,
    height,
    background,
    truncated: budget.truncated,
  };
}

export function odpSlidePage(
  page: Element,
  doc: Document,
  styleDoc?: Document,
): OfficePage {
  const budget = new OfficeBudget();
  const styles = odfStyles([...(styleDoc ? [styleDoc] : []), doc]);
  const pageName = attr(page, N.draw, "master-page-name");
  const master = descendants(styleDoc ?? doc, N.style, "master-page").find(
    (p) => attr(p, N.style, "name") === pageName,
  );
  const layoutName = attr(master, N.style, "page-layout-name");
  const layout = descendants(styleDoc ?? doc, N.style, "page-layout").find(
    (p) => attr(p, N.style, "name") === layoutName,
  );
  const properties = first(layout, N.style, "page-layout-properties");
  const width = Math.max(
      280,
      length(attr(properties, N.fo, "page-width")) ?? 960,
    ),
    height = Math.max(
      200,
      length(attr(properties, N.fo, "page-height")) ?? 540,
    );
  const shapes: OfficeShape[] = [];
  const frames = Array.from(page.children).filter(
    (n) =>
      n.namespaceURI === N.draw &&
      ["frame", "rect", "ellipse", "custom-shape"].includes(n.localName),
  );
  for (const frame of frames.slice(0, 1000)) {
    const blocks: OfficeBlock[] = [];
    const box = first(frame, N.draw, "text-box");
    if (box) blocks.push(...parseOdfDocument(box, styles, budget));
    const images = descendants(frame, N.draw, "image");
    const count = Math.min(images.length, budget.images);
    if (count < images.length) budget.truncated = true;
    budget.images -= count;
    for (const image of images.slice(0, count))
      blocks.push({
        kind: "image",
        path: attr(image, N.xlink, "href"),
        width: length(attr(frame, N.svg, "width")),
        height: length(attr(frame, N.svg, "height")),
      });
    const table = first(frame, N.table, "table");
    if (table) blocks.push(odfTable(table, styles, budget, false));
    const style = { ...styles.styleFor(frame, "graphic").paragraph };
    const node = styles.node("graphic", attr(frame, N.draw, "style-name"));
    const fill = attr(
      first(node, N.style, "graphic-properties"),
      N.draw,
      "fill-color",
    );
    if (/^#[\da-f]{6}$/i.test(fill)) style.backgroundColor = fill;
    shapes.push({
      x: length(attr(frame, N.svg, "x")) ?? 0,
      y: length(attr(frame, N.svg, "y")) ?? 0,
      width: Math.max(1, length(attr(frame, N.svg, "width")) ?? width * 0.8),
      height: Math.max(1, length(attr(frame, N.svg, "height")) ?? height * 0.2),
      ellipse: frame.localName === "ellipse",
      style: { ...style, padding: 4 },
      blocks,
    });
  }
  if (frames.length > shapes.length) budget.truncated = true;
  if (!frames.length)
    return {
      blocks: parseOdfDocument(page, styles, budget),
      width,
      height,
      truncated: budget.truncated,
    };
  return { blocks: [], shapes, width, height, truncated: budget.truncated };
}
