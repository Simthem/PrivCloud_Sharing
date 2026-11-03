import { openPreviewZip } from "./officePreview.util";
import {
  officeImageMime,
  type OfficeDocument,
} from "./officePreviewModel.util";
import type { PreviewByteSource } from "./previewRange.util";

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Pages, Numbers and Keynote packages carry a picture of their first page. */
const IWORK_PREVIEWS = [
  "preview.jpg",
  "QuickLook/Thumbnail.jpg",
  "preview-web.jpg",
  "QuickLook/Preview.jpg",
];

export async function openIworkDocument(
  source: PreviewByteSource,
  signal: AbortSignal,
): Promise<OfficeDocument> {
  const zip = await openPreviewZip(source, signal);
  const names = zip.names();
  // A package shared as a folder keeps it under the document name.
  const preview = IWORK_PREVIEWS.map(
    (name) =>
      names.find((entry) => entry === name || entry.endsWith(`/${name}`)) ??
      null,
  ).find((name) => name !== null);
  if (!preview) throw new Error("Document has no saved preview");
  return {
    kind: "document",
    units: [{ name: "", key: "preview" }],
    load: async () => ({
      blocks: [{ kind: "image", path: preview }],
      width: 794,
      height: 1123,
      padding: [24, 24, 24, 24],
      truncated: false,
    }),
    image: async (path, activeSignal = signal) => {
      if (path !== preview) return null;
      if ((zip.expandedSize(path) ?? 0) > IMAGE_MAX_BYTES) return null;
      const bytes = await zip.read(path, IMAGE_MAX_BYTES, activeSignal);
      return officeImageMime(bytes) ? bytes : null;
    },
  };
}
