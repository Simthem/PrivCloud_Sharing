import type { WebDavEntry } from "../services/webdav.service";
import { normalizeClientRelativePath } from "./uploadPath.util";

export type WebDavImportEntry = WebDavEntry & { uploadRelativePath?: string };
export const MAX_WEBDAV_IMPORT_FILES = 1000;
const MAX_DIRECTORIES = 4096;
const MAX_DEPTH = 63;

type Listing = { url: string; entries: WebDavEntry[] };

function resource(value: string): URL {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("webdav.error.unsafeTree");
  }
  return url;
}

function childName(parent: URL, child: URL): string {
  const prefix = parent.pathname.replace(/\/+$/, "") + "/";
  const pathname = child.pathname.replace(/\/+$/, "");
  if (parent.origin !== child.origin || !pathname.startsWith(prefix)) {
    throw new Error("webdav.error.unsafeTree");
  }
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new Error("webdav.error.unsafeTree");
  }
  // Each Depth:1 response must contain direct children, with safe path segments.
  if (normalizeClientRelativePath("root/" + name, name) !== "root/" + name) {
    throw new Error("webdav.error.unsafeTree");
  }
  return name;
}

/** Enumerates metadata only. Bytes still use the existing encrypted upload path. */
export async function collectWebDavFiles(options: {
  currentUrl: string;
  selected: WebDavEntry[];
  listDirectory: (_url: string, _signal?: AbortSignal) => Promise<Listing>;
  maxBytes: number;
  maxFiles?: number;
  signal?: AbortSignal;
  onProgress?: (_files: number, _directories: number) => void;
}): Promise<WebDavImportEntry[]> {
  const root = resource(options.currentUrl);
  const files: WebDavImportEntry[] = [];
  const seen = new Set<string>();
  const paths = new Set<string>();
  let bytes = 0,
    directories = 0;
  const maxFiles = Math.min(
    options.maxFiles ?? MAX_WEBDAV_IMPORT_FILES,
    MAX_WEBDAV_IMPORT_FILES,
  );
  const checkCancelled = () => options.signal?.throwIfAborted();

  const visit = async (
    entry: WebDavEntry,
    parent: URL,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    checkCancelled();
    const url = resource(entry.href);
    const name = childName(parent, url);
    const key = url.origin + url.pathname.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    const path = prefix ? prefix + "/" + name : name;
    if (path.length > 4096 || depth > MAX_DEPTH)
      throw new Error("webdav.error.treeLimit");
    if (entry.isDirectory) {
      if (++directories > MAX_DIRECTORIES)
        throw new Error("webdav.error.treeLimit");
      const listing = await options.listDirectory(url.href, options.signal);
      checkCancelled();
      const listed = resource(listing.url);
      if (listed.origin + listed.pathname.replace(/\/+$/, "") !== key)
        throw new Error("webdav.error.unsafeTree");
      for (const child of listing.entries)
        await visit(child, url, path, depth + 1);
    } else {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0)
        throw new Error("webdav.error.unsafeTree");
      bytes += entry.size;
      if (!Number.isSafeInteger(bytes) || bytes > options.maxBytes)
        throw new Error("webdav.error.quota");
      if (files.length >= maxFiles) throw new Error("webdav.error.treeLimit");
      if (paths.has(path)) throw new Error("webdav.error.unsafeTree");
      // FILE_META_V1 must retain the entire path instead of falling back to
      // a root-level file when its UTF-8 metadata exceeds the encryption cap.
      if (
        new TextEncoder().encode(
          JSON.stringify({ v: 1, n: name, ...(prefix ? { p: path } : {}) }),
        ).byteLength > 4096
      ) {
        throw new Error("webdav.error.treeLimit");
      }
      paths.add(path);
      files.push({
        ...entry,
        name,
        ...(prefix ? { uploadRelativePath: path } : {}),
      });
    }
    options.onProgress?.(files.length, directories);
  };

  if (
    !Number.isFinite(options.maxBytes) ||
    options.maxBytes < 0 ||
    !Number.isInteger(maxFiles) ||
    maxFiles < 1
  ) {
    throw new Error("webdav.error.quota");
  }
  for (const entry of options.selected) await visit(entry, root, "", 1);
  checkCancelled();
  if (!files.length) throw new Error("webdav.error.emptyFolder");
  return files;
}
