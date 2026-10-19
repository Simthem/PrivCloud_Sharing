import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { openOfficeDocument } from "../../../utils/officeDocumentPreview.util";
import type {
  OfficeDocument,
  OfficePage,
} from "../../../utils/officePreviewModel.util";
import type { PreviewByteSource } from "../../../utils/previewRange.util";
import {
  EXTERNAL_MAX_PAGES,
  externalPreviewKind,
  type Watermark,
} from "../../../utils/externalPreviewLayout.util";
import {
  ExternalPreviewError,
  rasterizeElement,
  releaseStyleSandbox,
  renderImagePage,
  renderPdfPages,
  renderTextPages,
  waitForStableLayout,
  type RenderedPage,
} from "../../../utils/externalPreviewRaster.util";
import { OfficePageContent } from "../../share/OfficePreview";
import styles from "../../share/OfficePreview.module.css";

/** The page as OfficePreview lays it out, at scale 1 and without shadow. */
function OfficeRasterPage({
  page,
  office,
  fr,
}: {
  page: OfficePage;
  office: OfficeDocument;
  fr: boolean;
}) {
  const workbook = office.kind === "workbook";
  const presentation = office.kind === "presentation";
  return (
    <div
      className={`${styles.paper} ${workbook ? styles.workbook : ""} ${presentation ? styles.slide : ""}`}
      style={{
        width: page.width,
        minHeight: workbook ? undefined : page.height,
        height: presentation ? page.height : undefined,
        backgroundColor: page.background ?? "#ffffff",
        boxShadow: "none",
        padding: page.padding
          ? page.padding.map((value) => value + "px").join(" ")
          : undefined,
      }}
    >
      <OfficePageContent page={page} document={office} fr={fr} />
      {!page.blocks.length && !page.shapes?.length && (
        <p>{fr ? "Aucun contenu à afficher." : "No content to display."}</p>
      )}
    </div>
  );
}

function unitLabel(
  office: OfficeDocument,
  unit: number,
  part: number,
  parts: number,
  fr: boolean,
) {
  const suffix = parts > 1 ? ` (${part + 1}/${parts})` : "";
  if (office.kind === "workbook") {
    const name =
      office.units[unit]?.name || `${fr ? "Feuille" : "Sheet"} ${unit + 1}`;
    return name.slice(0, 120) + suffix;
  }
  if (office.kind === "presentation") {
    return `${fr ? "Diapositive" : "Slide"} ${unit + 1}${suffix}`;
  }
  return parts > 1 ? `Page ${part + 1}/${parts}` : undefined;
}

async function renderOfficePages(
  source: PreviewByteSource,
  mimeType: string,
  locale: string,
  watermark: Watermark,
  signal: AbortSignal,
  sink: (_page: RenderedPage) => void,
  onUnit: (_done: number, _total: number) => void,
) {
  const office = await openOfficeDocument(
    source,
    signal,
    mimeType,
    new DOMParser(),
    locale,
  );
  const fr = locale.startsWith("fr");
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  // Laid out off screen: rasterizing needs real computed styles and sizes.
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;pointer-events:none;contain:layout paint";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    for (let unit = 0; unit < office.units.length; unit++) {
      signal.throwIfAborted();
      const page = await office.load(unit, signal);
      flushSync(() =>
        root.render(<OfficeRasterPage page={page} office={office} fr={fr} />),
      );
      const paper = host.firstElementChild as HTMLElement | null;
      if (!paper) throw new ExternalPreviewError("unsupported");
      await waitForStableLayout(paper, signal);
      await rasterizeElement(paper, watermark, signal, sink, (part, parts) =>
        unitLabel(office, unit, part, parts, fr),
      );
      onUnit(unit + 1, office.units.length);
    }
  } finally {
    root.unmount();
    host.remove();
  }
}

/**
 * Render a decrypted team file into watermarked page images. The result never
 * contains the original bytes: each page is a bitmap re-encoded from a canvas.
 */
export async function renderExternalPreview(options: {
  source: PreviewByteSource;
  mimeType: string;
  locale: string;
  watermark: Watermark;
  signal: AbortSignal;
  onProgress?: (_pages: number, _done?: number, _total?: number) => void;
}): Promise<RenderedPage[]> {
  const { source, mimeType, locale, watermark, signal, onProgress } = options;
  const kind = externalPreviewKind(mimeType);
  if (!kind) throw new ExternalPreviewError("unsupported");
  const pages: RenderedPage[] = [];
  const sink = (page: RenderedPage) => {
    if (pages.length >= EXTERNAL_MAX_PAGES) {
      throw new ExternalPreviewError("too_many_pages");
    }
    pages.push(page);
    onProgress?.(pages.length);
  };
  try {
    if (kind === "pdf") {
      await renderPdfPages(source, watermark, signal, sink, (done, total) =>
        onProgress?.(pages.length, done, total),
      );
    } else if (kind === "image") {
      await renderImagePage(source, mimeType, watermark, signal, sink);
    } else if (kind === "text") {
      await renderTextPages(source, watermark, signal, sink);
    } else {
      await renderOfficePages(
        source,
        mimeType,
        locale,
        watermark,
        signal,
        sink,
        (done, total) => onProgress?.(pages.length, done, total),
      );
    }
  } finally {
    releaseStyleSandbox();
  }
  if (pages.length === 0) throw new ExternalPreviewError("unsupported");
  return pages;
}
