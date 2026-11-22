import type { ThrownError } from "../types/thrownError.type";

/** Translation key for a failed download, null when it was cancelled. */
export const downloadErrorKey = (error: unknown): string | null => {
  const name = (error as ThrownError | null)?.name;
  if (name === "AbortError") return null;
  return name === "LargeDownloadRequiresDiskAccessError"
    ? "download.error.too-large"
    : "download.error.failed";
};
