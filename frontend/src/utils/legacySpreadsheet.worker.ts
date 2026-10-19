import {
  parseLegacyWorkbook,
  legacySheetValues,
} from "./legacySpreadsheetParser.util";
import type { WorkBook } from "xlsx";

let workbook: WorkBook | undefined;
const scope = self as unknown as {
  onmessage: ((_event: MessageEvent) => void) | null;
  postMessage: (_data: unknown) => void;
};
scope.onmessage = (event) => {
  if (!event.isTrusted || event.origin !== "") return;
  const data = event.data;
  if (!data || !Number.isSafeInteger(data.id) || data.id < 1) return;
  try {
    if (
      data.type === "open" &&
      Object.keys(data).length === 3 &&
      data.bytes instanceof ArrayBuffer
    ) {
      workbook = parseLegacyWorkbook(new Uint8Array(data.bytes));
      scope.postMessage({
        id: data.id,
        type: "opened",
        units: workbook.SheetNames.map((name) => name.slice(0, 128)),
      });
    } else if (
      data.type === "load" &&
      Object.keys(data).length === 3 &&
      workbook &&
      Number.isSafeInteger(data.index)
    ) {
      scope.postMessage({
        id: data.id,
        type: "sheet",
        ...legacySheetValues(workbook, data.index),
      });
    }
  } catch {
    scope.postMessage({ id: data.id, type: "error" });
  }
};
