import { all, createLowlight } from "lowlight";
import type { RootContent } from "hast";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  CODE_HIGHLIGHT_MAX_TOKENS,
  isCodeTokenClass,
  type CodeHighlight,
  type CodeToken,
} from "./codePreview.util";

const highlighter = createLowlight(all);

/** Return text tokens rather than HTML. Never interpret uploaded markup. */
export function parseCodeHighlight(
  text: string,
  language: string,
): CodeHighlight {
  if (
    text.length > CODE_HIGHLIGHT_MAX_CHARS ||
    !highlighter.registered(language)
  )
    throw new Error(
      "Source code exceeds highlight budget or has an unknown language",
    );
  const root = highlighter.highlight(language, text);
  const tokens: CodeToken[] = [];
  let visited = 0;
  let consumed = 0;
  let limited = false;
  const visit = (node: RootContent, inherited: string[], depth: number) => {
    if (limited) return;
    if (++visited > 30_000 || depth > 32) {
      limited = true;
      return;
    }
    if (node.type === "text") {
      const previous = tokens[tokens.length - 1];
      if (previous && previous.classes.join(" ") === inherited.join(" "))
        previous.text += node.value;
      else {
        if (tokens.length >= CODE_HIGHLIGHT_MAX_TOKENS - 1) {
          limited = true;
          return;
        }
        tokens.push({ text: node.value, classes: inherited });
      }
      consumed += node.value.length;
    } else if (node.type === "element" && node.tagName === "span") {
      const rawClasses = node.properties.className || [];
      if (!Array.isArray(rawClasses))
        throw new Error("Invalid source code token");
      const classes = rawClasses.map((value) =>
        typeof value === "string" && highlighter.registered(value)
          ? `language-${value}`
          : value,
      );
      if (!classes.every(isCodeTokenClass))
        throw new Error("Invalid source code token");
      const combined = [...new Set([...inherited, ...classes])];
      if (combined.length > 8)
        throw new Error("Source code exceeds token depth budget");
      for (const child of node.children) visit(child, combined, depth + 1);
    } else throw new Error("Invalid source code token");
  };
  for (const child of root.children) visit(child, [], 0);
  if (limited) tokens.push({ text: text.slice(consumed), classes: [] });
  return { tokens, limited };
}
