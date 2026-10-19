import {
  CODE_HIGHLIGHT_MAX_CHARS,
  isCodeHighlight,
  type CodeHighlight,
} from "./codePreview.util";

/** Highlight only in a disposable worker. Decrypted source remains local. */
export async function highlightCodePreview(
  text: string,
  language: string,
  signal: AbortSignal,
): Promise<CodeHighlight> {
  signal.throwIfAborted();
  const prefix = text.slice(0, CODE_HIGHLIGHT_MAX_CHARS);
  const worker = new Worker(
    new URL("./codeHighlight.worker.ts", import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const finish = (result?: CodeHighlight, error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (result) resolve(result);
      else reject(error || new Error("Unable to highlight source code"));
    };
    const abort = () => finish(undefined, signal.reason);
    const timer = setTimeout(() => finish(), 3_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish();
    worker.onmessage = (event) => {
      if (!event.isTrusted || event.origin !== "" || event.target !== worker)
        return;
      const data = event.data;
      if (
        !data ||
        data.id !== 1 ||
        data.type !== "highlighted" ||
        Object.keys(data).length !== 4
      ) {
        finish();
        return;
      }
      const result = { tokens: data.tokens, limited: data.limited };
      if (
        !isCodeHighlight(result) ||
        result.tokens.map((token) => token.text).join("") !== prefix
      ) {
        finish();
        return;
      }
      finish({ ...result, limited: result.limited || text.length > prefix.length });
    };
    worker.postMessage({ id: 1, type: "highlight", text: prefix, language });
  });
}
