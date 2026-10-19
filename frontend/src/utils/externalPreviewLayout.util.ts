import {
  isOfficePreviewMimeType,
  isTextBasedMimeType,
} from "./filePreview.util";
import { isPreviewableImageMimeType } from "./imageFormats.util";

// Layout rules of the copies rendered for external contractors. Images are
// bounded so a page stays readable on screen without approaching the
// resolution of the original.

export const EXTERNAL_PAGE_MAX_WIDTH = 1400;
export const EXTERNAL_TILE_MAX_HEIGHT = 1800;
export const EXTERNAL_MAX_PAGES = 300;
// The server refuses an encrypted page above 6 MiB, IV and tag included.
export const EXTERNAL_PAGE_MAX_BYTES = 6 * 1024 * 1024 - 64;
export const EXTERNAL_IMAGE_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const EXTERNAL_TEXT_MAX_SOURCE_BYTES = 1024 * 1024;

export type ExternalPreviewKind = "pdf" | "image" | "office" | "text";

export function externalPreviewKind(
  mimeType: string,
): ExternalPreviewKind | null {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return "pdf";
  if (isOfficePreviewMimeType(mime)) return "office";
  if (isPreviewableImageMimeType(mime)) return "image";
  if (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/")
  )
    return null;
  if (isTextBasedMimeType(mime)) return "text";
  return null;
}

export type Tile = { x: number; y: number; width: number; height: number };

/**
 * Output scale and tiles of a laid-out page of width x height CSS pixels.
 * Narrow pages are enlarged up to 2x, wide ones keep 1x and are cut in
 * columns: a 100-column sheet stays legible instead of shrinking.
 */
export function computeTiles(
  width: number,
  height: number,
): { scale: number; tiles: Tile[] } {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const scale = Math.min(2, Math.max(1, EXTERNAL_PAGE_MAX_WIDTH / w));
  const tileWidth = Math.floor(EXTERNAL_PAGE_MAX_WIDTH / scale);
  const tileHeight = Math.floor(EXTERNAL_TILE_MAX_HEIGHT / scale);
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y += tileHeight) {
    for (let x = 0; x < w; x += tileWidth) {
      tiles.push({
        x,
        y,
        width: Math.min(tileWidth, w - x),
        height: Math.min(tileHeight, h - y),
      });
    }
  }
  return { scale, tiles };
}

/** Hard-wrap text for a monospace page, tabs as four spaces. */
export function wrapTextLines(text: string, maxChars: number): string[] {
  const width = Math.max(10, Math.floor(maxChars));
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "    ");
    if (line.length === 0) {
      lines.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += width) {
      lines.push(line.slice(i, i + width));
    }
  }
  return lines;
}

export type Watermark = {
  // Repeated diagonally over the whole page.
  text: string;
  // Bottom band, readable on any crop.
  footer: string;
  // Invisible pattern of this copy (see forensicMark.util), added last.
  forensic?: Float32Array;
  robustForensic?: boolean;
  visibleToken?: string;
};

/**
 * The owner first (the sharing company, when its details are set), then the
 * contractor it was rendered for, so that any leaked capture names both.
 */
export function buildWatermark(info: {
  name: string;
  email: string;
  date: Date;
  company?: { companyName: string; mention?: string; details?: string };
  defaultMention: string;
}): Watermark {
  const date = info.date.toISOString().slice(0, 10);
  const name = info.name.trim() || info.email;
  const recipient =
    name === info.email ? info.email : `${name} - ${info.email}`;
  if (!info.company?.companyName) {
    const text = `${recipient} - ${date}`;
    return { text, footer: text };
  }
  const company = info.company.companyName;
  const mention = info.company.mention || info.defaultMention;
  return {
    text: `${company} - ${mention} - ${info.email} - ${date}`,
    footer: [company, info.company.details, recipient, date]
      .filter(Boolean)
      .join(" - "),
  };
}
