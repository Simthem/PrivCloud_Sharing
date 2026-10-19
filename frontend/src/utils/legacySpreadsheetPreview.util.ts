import { zipSync } from "fflate";
import { openPreviewZip } from "./officePreview.util";
import { readPreviewBytes, type PreviewByteSource } from "./previewRange.util";
import type { OfficeDocument } from "./officePreviewModel.util";

const MAX_BYTES = 16 * 1024 * 1024;
const TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/x-sylk",
  "text/x-sylk",
  "application/x-dif",
  "application/x-lotus-123",
  "application/x-dbf",
]);
export const isLegacySpreadsheetMimeType = (value: string) =>
  TYPES.has(value.toLowerCase().split(";")[0].trim());

/** Validate worker output before creating React text nodes. */
export function isLegacySheetReply(value: unknown): value is {
  id: number;
  type: "sheet";
  rows: string[][];
  truncated: boolean;
} {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    data.type !== "sheet" ||
    !Number.isSafeInteger(data.id) ||
    typeof data.truncated !== "boolean" ||
    !Array.isArray(data.rows) ||
    data.rows.length > 500
  )
    return false;
  let chars = 0;
  return data.rows.every(
    (row) =>
      Array.isArray(row) &&
      row.length <= 100 &&
      row.every(
        (cell) =>
          typeof cell === "string" &&
          cell.length <= 16_384 &&
          (chars += cell.length) <= 1024 * 1024,
      ),
  );
}

export async function openLegacySpreadsheet(
  source: PreviewByteSource,
  signal: AbortSignal,
): Promise<OfficeDocument> {
  signal.throwIfAborted();
  if (source.size <= 0 || source.size > MAX_BYTES)
    throw new Error("Spreadsheet exceeds preview budget");
  let bytes = await readPreviewBytes(source, 0, source.size, signal);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // XLSB ZIPs are decompressed with hard limits and rebuilt as stored entries.
    // This keeps the third-party parser away from unverified compressed content.
    const zip = await openPreviewZip(source, signal);
    const entries = Object.create(null) as Record<string, Uint8Array>;
    let expanded = 0;
    if (zip.names().length > 256)
      throw new Error("Spreadsheet exceeds entry budget");
    for (const name of zip.names()) {
      if (name.endsWith("/")) continue;
      if (!/^[\w .\-/\[\]]+$/.test(name) || name.split("/").includes(".."))
        throw new Error("Invalid spreadsheet part");
      expanded += zip.expandedSize(name) ?? 0;
      if (expanded > MAX_BYTES)
        throw new Error("Spreadsheet exceeds expanded budget");
      entries[name] = await zip.read(name, MAX_BYTES, signal);
    }
    bytes = zipSync(entries, { level: 0 });
  }
  signal.throwIfAborted();
  const worker = new Worker(
    new URL("./legacySpreadsheet.worker.ts", import.meta.url),
  );
  let id = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (_value: any) => void;
      reject: (_reason: unknown) => void;
      cleanup: () => void;
    }
  >();
  const close = () => {
    closed = true;
    worker.terminate();
    signal.removeEventListener("abort", close);
    for (const task of pending.values()) {
      task.cleanup();
      task.reject(new Error("Spreadsheet preview stopped"));
    }
    pending.clear();
  };
  signal.addEventListener("abort", close, { once: true });
  worker.onerror = close;
  worker.onmessage = (event) => {
    if (!event.isTrusted || event.origin !== "" || event.target !== worker)
      return;
    const data = event.data;
    if (!data || !Number.isSafeInteger(data.id) || !pending.has(data.id))
      return;
    const valid =
      isLegacySheetReply(data) ||
      (data.type === "opened" &&
        Object.keys(data).length === 3 &&
        Array.isArray(data.units) &&
        data.units.length > 0 &&
        data.units.length <= 100 &&
        data.units.every(
          (name: unknown) => typeof name === "string" && name.length <= 128,
        ));
    const task = pending.get(data.id)!;
    pending.delete(data.id);
    task.cleanup();
    if (valid) task.resolve(data);
    else {
      task.reject(new Error("Unable to preview spreadsheet"));
      close();
    }
  };
  const call = (
    data: Record<string, unknown>,
    activeSignal = signal,
    transfer: Transferable[] = [],
  ) =>
    new Promise<any>((resolve, reject) => {
      activeSignal.throwIfAborted();
      signal.throwIfAborted();
      if (closed) {
        reject(new Error("Spreadsheet preview stopped"));
        return;
      }
      const requestId = ++id;
      const timer = setTimeout(close, 15_000);
      const abort = () => {
        pending.delete(requestId);
        cleanup();
        reject(activeSignal.reason);
      };
      const cleanup = () => {
        clearTimeout(timer);
        activeSignal.removeEventListener("abort", abort);
      };
      pending.set(requestId, { resolve, reject, cleanup });
      activeSignal.addEventListener("abort", abort, { once: true });
      worker.postMessage({ ...data, id: requestId }, transfer);
    });
  try {
    const buffer = bytes.slice().buffer;
    const opened = await call({ type: "open", bytes: buffer }, signal, [
      buffer,
    ]);
    return {
      kind: "workbook",
      units: opened.units.map((name: string, index: number) => ({
        name,
        key: String(index),
      })),
      image: async () => null,
      load: async (index, activeSignal = signal) => {
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= opened.units.length
        )
          throw new Error("Invalid worksheet index");
        const reply = await call({ type: "load", index }, activeSignal);
        const cols = Math.max(
          1,
          ...reply.rows.map((row: string[]) => row.length),
        );
        return {
          blocks: [
            {
              kind: "table",
              grid: true,
              rows: reply.rows.map((row: string[], r: number) => ({
                index: r + 1,
                cells: row.map((text) => ({ runs: [{ text }] })),
              })),
            },
          ],
          width: 48 + cols * 110,
          height: 600,
          truncated: reply.truncated,
        };
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
