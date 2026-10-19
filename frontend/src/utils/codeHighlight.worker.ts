import { parseCodeHighlight } from "./codeHighlightParser.util";
import { CODE_HIGHLIGHT_MAX_CHARS } from "./codePreview.util";

const scope = self as unknown as {
  onmessage: ((_event: MessageEvent) => void) | null;
  postMessage: (_data: unknown) => void;
};
scope.onmessage = (event) => {
  if (!event.isTrusted || event.origin !== "") return;
  const data = event.data;
  if (
    !data ||
    data.id !== 1 ||
    data.type !== "highlight" ||
    Object.keys(data).length !== 4 ||
    typeof data.text !== "string" ||
    data.text.length > CODE_HIGHLIGHT_MAX_CHARS ||
    typeof data.language !== "string" ||
    data.language.length > 32
  )
    return;
  try {
    scope.postMessage({
      id: 1,
      type: "highlighted",
      ...parseCodeHighlight(data.text, data.language),
    });
  } catch {
    scope.postMessage({ id: 1, type: "error" });
  }
};
