/**
 * Hands an in-memory Blob (signed PDF, evidence export) to the browser's
 * download flow.
 *
 * The object URL is released a moment after the click, as downloadDecryptedBlob
 * does for shared files, rather than in the same task: mobile Safari reads a
 * blob: URL only once the download has actually started, and a URL revoked
 * before that point leaves the reader with an empty or failed download.
 */
export const saveBlobToDevice = async (
  blob: Blob,
  fileName: string,
): Promise<boolean> => {
  const safeName = fileName.replace(/[/\\\0]/g, "_").replace(/^\.\./, "_");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeName;
  anchor.rel = "noopener noreferrer";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
};
