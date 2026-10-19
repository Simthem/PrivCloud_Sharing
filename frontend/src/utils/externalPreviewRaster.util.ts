import { embedMark } from "./forensicMark.util";
import { embedRobustCopyMark } from "./robustCopyMark.util";
import { appendCopyMarker } from "./visibleCopyMark.util";
import { readPreviewBytes, type PreviewByteSource } from "./previewRange.util";
import { decodePreviewText } from "./textPreview.util";
import { toDisplayableImageBlob } from "./imageDecoder.util";
import { imageDecoderFormat } from "./imageFormats.util";
import {
  computeTiles,
  type Watermark,
  EXTERNAL_IMAGE_MAX_SOURCE_BYTES,
  EXTERNAL_MAX_PAGES,
  EXTERNAL_PAGE_MAX_BYTES,
  EXTERNAL_PAGE_MAX_WIDTH,
  EXTERNAL_TEXT_MAX_SOURCE_BYTES,
  wrapTextLines,
} from "./externalPreviewLayout.util";

// Browser side of the copies rendered for external contractors: every format
// ends as a watermarked bitmap re-encoded from a canvas, so nothing of the
// original file (text layer, metadata, embedded objects) reaches them.

type PreviewErrorCode =
  | "unsupported"
  | "too_many_pages"
  | "too_large"
  | "browser_unsupported";

export class ExternalPreviewError extends Error {
  readonly code: PreviewErrorCode;

  constructor(code: PreviewErrorCode) {
    super(code);
    this.code = code;
  }
}

export type RenderedPage = {
  image: Blob;
  width: number;
  height: number;
  label?: string;
};

export type PageSink = (_page: RenderedPage) => void;

export function createPageCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new ExternalPreviewError("browser_unsupported");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

/** Diagonal, repeated and semi-transparent: it survives cropping. */
export function drawWatermark(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  watermark: Watermark,
) {
  const text = watermark.text;
  const size = Math.max(14, Math.round(Math.min(width, height) / 32));
  context.save();
  context.font = `600 ${size}px sans-serif`;
  context.fillStyle = "rgba(180, 30, 30, 0.16)";
  context.textBaseline = "middle";
  const step = context.measureText(text).width + size * 3;
  const diagonal = Math.hypot(width, height);
  context.translate(width / 2, height / 2);
  context.rotate(-Math.PI / 6);
  for (let y = -diagonal / 2; y < diagonal / 2; y += size * 5) {
    const offset = (Math.round(y / (size * 5)) % 2) * (step / 2);
    for (let x = -diagonal / 2 - offset; x < diagonal / 2; x += step) {
      context.fillText(text, x, y);
    }
  }
  context.restore();
  // A plain band at the bottom keeps the name readable on every crop.
  context.save();
  // Shrunk until the whole line fits: company details make it long.
  let bandSize = Math.max(11, Math.round(size * 0.6));
  context.font = `600 ${bandSize}px sans-serif`;
  while (
    bandSize > 7 &&
    context.measureText(watermark.footer).width > width - 24
  ) {
    bandSize--;
    context.font = `600 ${bandSize}px sans-serif`;
  }
  context.fillStyle = "rgba(120, 20, 20, 0.55)";
  context.textAlign = "right";
  context.textBaseline = "bottom";
  context.fillText(watermark.footer, width - 12, height - 8);
  context.restore();
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve, reject) => {
    try {
      canvas.toBlob(resolve, type, quality);
    } catch (error) {
      // A tainted canvas (Safari with SVG foreignObject) refuses any export.
      reject(
        error instanceof DOMException && error.name === "SecurityError"
          ? new ExternalPreviewError("browser_unsupported")
          : error,
      );
    }
  });
}

/** Preserve forensic pixels exactly. Reject oversized marked pages. */
export async function encodePage(
  canvas: HTMLCanvasElement,
  forensic = false,
): Promise<Blob> {
  if (forensic) {
    const blob = await canvasBlob(canvas, "image/png", 1);
    if (
      !blob ||
      blob.type !== "image/png" ||
      blob.size > EXTERNAL_PAGE_MAX_BYTES
    )
      throw new ExternalPreviewError("too_large");
    return blob;
  }
  for (const quality of [0.82, 0.68, 0.5]) {
    for (const type of ["image/webp", "image/jpeg"]) {
      const blob = await canvasBlob(canvas, type, quality);
      // Unsupported types silently fall back to PNG: try the next one.
      if (!blob || blob.type !== type) continue;
      if (blob.size <= EXTERNAL_PAGE_MAX_BYTES) return blob;
      break;
    }
  }
  throw new ExternalPreviewError("too_large");
}

/** Adds the invisible pattern of the copy over everything drawn so far. */
function embedPageMark(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  pattern: Float32Array,
  robust: boolean,
) {
  let image: ImageData;
  try {
    image = context.getImageData(0, 0, width, height);
  } catch (error) {
    // A tainted canvas (Safari with SVG foreignObject) refuses any read.
    throw error instanceof DOMException && error.name === "SecurityError"
      ? new ExternalPreviewError("browser_unsupported")
      : error;
  }
  if (robust) embedRobustCopyMark(image, pattern);
  embedMark(image, pattern);
  context.putImageData(image, 0, 0);
}

function checkPageCount(count: number) {
  if (count > EXTERNAL_MAX_PAGES) {
    throw new ExternalPreviewError("too_many_pages");
  }
}

async function finishPage(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  watermark: Watermark,
  sink: PageSink,
  label?: string,
) {
  drawWatermark(context, canvas.width, canvas.height, watermark);
  const originalCanvas = canvas;
  if (watermark.visibleToken) {
    const marked = appendCopyMarker(canvas, watermark.visibleToken);
    canvas = marked.canvas;
    context = marked.context;
  }
  if (watermark.forensic) {
    embedPageMark(
      context,
      canvas.width,
      canvas.height,
      watermark.forensic,
      watermark.robustForensic === true,
    );
  }
  sink({
    image: await encodePage(canvas, Boolean(watermark.forensic)),
    width: canvas.width,
    height: canvas.height,
    label,
  });
  canvas.width = canvas.height = 0;
  originalCanvas.width = originalCanvas.height = 0;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export async function renderPdfPages(
  source: PreviewByteSource,
  watermark: Watermark,
  signal: AbortSignal,
  sink: PageSink,
  onProgress?: (_done: number, _total: number) => void,
) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const transport = new pdfjs.PDFDataRangeTransport(
    source.size,
    await readPreviewBytes(source, 0, Math.min(source.size, 64 * 1024), signal),
    true,
  );
  transport.requestDataRange = (begin, end) => {
    readPreviewBytes(source, begin, end, signal)
      .then((bytes) => {
        if (!signal.aborted) transport.onDataRange(begin, bytes);
      })
      .catch(() => undefined);
  };
  const task = pdfjs.getDocument({
    range: transport,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 64 * 1024,
    isEvalSupported: false,
  });
  const onAbort = () => void task.destroy();
  signal.addEventListener("abort", onAbort);
  try {
    const document = await task.promise;
    checkPageCount(document.numPages);
    for (let number = 1; number <= document.numPages; number++) {
      signal.throwIfAborted();
      const page = await document.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        2,
        EXTERNAL_PAGE_MAX_WIDTH / base.width,
        Math.sqrt(4_000_000 / (base.width * base.height)),
      );
      const viewport = page.getViewport({ scale });
      const { canvas, context } = createPageCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      // Annotations and forms are flattened into the bitmap with the page.
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
      await finishPage(canvas, context, watermark, sink);
      onProgress?.(number, document.numPages);
    }
    await document.destroy();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export async function renderImagePage(
  source: PreviewByteSource,
  mimeType: string,
  watermark: Watermark,
  signal: AbortSignal,
  sink: PageSink,
) {
  if (source.size > EXTERNAL_IMAGE_MAX_SOURCE_BYTES) {
    throw new ExternalPreviewError("too_large");
  }
  // readPreviewBytes caps one call at 16 MiB.
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < source.size; start += 16 * 1024 * 1024) {
    const end = Math.min(source.size, start + 16 * 1024 * 1024);
    parts.push(await readPreviewBytes(source, start, end, signal));
  }
  // HEIC, TIFF and RAW are decoded on the device first, at the page's size.
  const url = URL.createObjectURL(
    imageDecoderFormat(mimeType)
      ? await toDisplayableImageBlob(
          await new Blob(parts).arrayBuffer(),
          mimeType,
          signal,
          2000,
        )
      : new Blob(parts, { type: mimeType }),
  );
  try {
    // An <img> never runs the scripts an SVG file may carry.
    const image = new Image();
    image.src = url;
    await image.decode();
    const longest = Math.max(image.naturalWidth, image.naturalHeight, 1);
    const scale = Math.min(1, 2000 / longest);
    const { canvas, context } = createPageCanvas(
      Math.max(1, Math.round(image.naturalWidth * scale)),
      Math.max(1, Math.round(image.naturalHeight * scale)),
    );
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    await finishPage(canvas, context, watermark, sink);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Text and source code
// ---------------------------------------------------------------------------

export async function renderTextPages(
  source: PreviewByteSource,
  watermark: Watermark,
  signal: AbortSignal,
  sink: PageSink,
) {
  const length = Math.min(source.size, EXTERNAL_TEXT_MAX_SOURCE_BYTES);
  const bytes = await readPreviewBytes(source, 0, length, signal);
  const text = decodePreviewText(bytes, length < source.size);
  const width = 1240;
  const height = 1754;
  const margin = 56;
  const fontSize = 15;
  const lineHeight = 22;
  const probe = createPageCanvas(1, 1).context;
  probe.font = `${fontSize}px monospace`;
  const charWidth = probe.measureText("M").width || fontSize * 0.6;
  const lines = wrapTextLines(text, (width - margin * 2) / charWidth);
  const perPage = Math.floor((height - margin * 2) / lineHeight);
  const pages = Math.max(1, Math.ceil(lines.length / perPage));
  checkPageCount(pages);
  for (let page = 0; page < pages; page++) {
    signal.throwIfAborted();
    const { canvas, context } = createPageCanvas(width, height);
    context.font = `${fontSize}px monospace`;
    context.fillStyle = "#1f2328";
    context.textBaseline = "top";
    lines.slice(page * perPage, (page + 1) * perPage).forEach((line, i) => {
      context.fillText(line, margin, margin + i * lineHeight);
    });
    await finishPage(canvas, context, watermark, sink);
  }
}

// ---------------------------------------------------------------------------
// Laid-out DOM (Office documents, sheets and slides)
// ---------------------------------------------------------------------------

const defaultStyles = new Map<string, Map<string, string>>();
let styleSandbox: HTMLIFrameElement | null = null;

/** Computed style of a bare element, to keep only what the page changed. */
function defaultStyleOf(tagName: string): Map<string, string> {
  const cached = defaultStyles.get(tagName);
  if (cached) return cached;
  if (!styleSandbox) {
    styleSandbox = document.createElement("iframe");
    styleSandbox.setAttribute("aria-hidden", "true");
    styleSandbox.style.cssText =
      "position:fixed;left:-10000px;top:0;width:10px;height:10px;border:0;visibility:hidden";
    document.body.appendChild(styleSandbox);
  }
  const sandbox = styleSandbox.contentDocument!;
  const element = sandbox.createElement(tagName);
  sandbox.body.appendChild(element);
  const computed = styleSandbox.contentWindow!.getComputedStyle(element);
  const values = new Map<string, string>();
  for (let i = 0; i < computed.length; i++) {
    values.set(computed[i], computed.getPropertyValue(computed[i]));
  }
  element.remove();
  defaultStyles.set(tagName, values);
  return values;
}

export function releaseStyleSandbox() {
  styleSandbox?.remove();
  styleSandbox = null;
  defaultStyles.clear();
}

async function dataUrlOf(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Self-contained copy: inline styles, images as data URLs, no classes. */
async function selfContainedClone(root: HTMLElement): Promise<HTMLElement> {
  const clone = root.cloneNode(true) as HTMLElement;
  const sources = [root, ...Array.from(root.querySelectorAll("*"))];
  const targets = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i] as HTMLElement;
    const target = targets[i] as HTMLElement;
    const computed = getComputedStyle(source);
    const defaults = defaultStyleOf(source.tagName.toLowerCase());
    let style = "";
    for (let p = 0; p < computed.length; p++) {
      const name = computed[p];
      const value = computed.getPropertyValue(name);
      if (defaults.get(name) !== value) style += `${name}:${value};`;
    }
    target.removeAttribute("class");
    target.setAttribute("style", style);
    if (target instanceof HTMLImageElement) {
      const src = (source as HTMLImageElement).currentSrc;
      const data = src ? await dataUrlOf(src) : null;
      if (data) target.setAttribute("src", data);
      else target.remove();
    }
  }
  return clone;
}

function loadSvg(markup: string) {
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
  return image.decode().then(() => image);
}

/**
 * Rasterize a laid-out element through an SVG foreignObject, tile by tile, so
 * a long document or a wide sheet never needs one huge canvas.
 */
export async function rasterizeElement(
  root: HTMLElement,
  watermark: Watermark,
  signal: AbortSignal,
  sink: PageSink,
  label?: (_index: number, _count: number) => string | undefined,
) {
  const width = Math.max(root.scrollWidth, root.offsetWidth);
  const height = Math.max(root.scrollHeight, root.offsetHeight);
  const { scale, tiles } = computeTiles(width, height);
  checkPageCount(tiles.length);
  const clone = await selfContainedClone(root);
  clone.style.margin = "0";
  const xml = new XMLSerializer().serializeToString(clone);
  for (let index = 0; index < tiles.length; index++) {
    signal.throwIfAborted();
    const tile = tiles[index];
    const outWidth = Math.round(tile.width * scale);
    const outHeight = Math.round(tile.height * scale);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" ` +
      `viewBox="${tile.x} ${tile.y} ${tile.width} ${tile.height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${xml}</foreignObject></svg>`;
    const image = await loadSvg(svg);
    const { canvas, context } = createPageCanvas(outWidth, outHeight);
    context.drawImage(image, 0, 0, outWidth, outHeight);
    await finishPage(
      canvas,
      context,
      watermark,
      sink,
      label?.(index, tiles.length),
    );
  }
}

/** Resolves once the subtree stopped changing and its images decoded. */
export async function waitForStableLayout(
  root: HTMLElement,
  signal: AbortSignal,
  quietMs = 400,
  timeoutMs = 20_000,
) {
  await new Promise<void>((resolve) => {
    let timer = setTimeout(done, quietMs);
    const deadline = setTimeout(done, timeoutMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(deadline);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
  signal.throwIfAborted();
  await Promise.all(
    Array.from(root.querySelectorAll("img")).map((image) =>
      image.decode().catch(() => undefined),
    ),
  );
}
