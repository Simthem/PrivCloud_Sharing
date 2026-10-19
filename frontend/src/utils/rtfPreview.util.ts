import type { CSSProperties } from "react";
import {
  OfficeBudget,
  type OfficePage,
  type OfficeRun,
} from "./officePreviewModel.util";

/** RTF formatting is interpreted as local React text/styles, never as markup. */
export function parseRtfPreview(source: string): OfficePage {
  if (!/^\{\\rtf[1-9]/.test(source)) throw new Error("Invalid RTF document");
  const budget = new OfficeBudget();
  const colors = (source.match(/\{\\colortbl([^{}]*)\}/)?.[1] ?? "")
    .split(";")
    .slice(0, 256)
    .map((part) => {
      const rgb = ["red", "green", "blue"].map((name) =>
        Math.min(
          255,
          Number(
            part.match(new RegExp("\\\\" + name + "(\\d{1,3})"))?.[1] ?? 0,
          ),
        ),
      );
      return part.trim()
        ? "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("")
        : undefined;
    });
  type State = {
    skip: boolean;
    uc: number;
    style: CSSProperties;
    paragraph: CSSProperties;
  };
  let state: State = { skip: false, uc: 1, style: {}, paragraph: {} };
  const stack: State[] = [];
  const blocks: OfficePage["blocks"] = [];
  let runs: OfficeRun[] = [],
    text = "",
    fallback = 0;
  const flush = () => {
    if (text) {
      if (budget.nodes-- > 0 && runs.length < 2048)
        runs.push({ text: budget.take(text), style: { ...state.style } });
      else budget.truncated = true;
      text = "";
    }
  };
  const paragraph = () => {
    flush();
    if (runs.length)
      blocks.push({ kind: "paragraph", runs, style: { ...state.paragraph } });
    runs = [];
  };
  for (
    let i = 0;
    i < source.length &&
    blocks.length < 2000 &&
    budget.chars > 0 &&
    budget.nodes > 0;
    i++
  ) {
    const ch = source[i];
    if (ch === "{") {
      flush();
      if (stack.length >= 64)
        throw new Error("RTF nesting exceeds preview budget");
      stack.push(state);
      state = {
        ...state,
        style: { ...state.style },
        paragraph: { ...state.paragraph },
      };
    } else if (ch === "}") {
      flush();
      state = stack.pop() ?? state;
    } else if (ch === "\\") {
      flush();
      const next = source[++i];
      if (["\\", "{", "}"].includes(next)) {
        if (fallback) fallback--;
        else if (!state.skip) text += next;
        continue;
      }
      if (next === "*") {
        state.skip = true;
        continue;
      }
      if (next === "'") {
        const hex = source.slice(i + 1, i + 3);
        i += 2;
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("Invalid RTF escape");
        if (fallback) fallback--;
        else if (!state.skip)
          text += new TextDecoder("windows-1252").decode(
            Uint8Array.of(parseInt(hex, 16)),
          );
        continue;
      }
      if (next === "~") {
        if (!state.skip) text += "\u00a0";
        continue;
      }
      if (next === "-") continue;
      const match = source.slice(i).match(/^([a-z]+)(-?\d+)? ?/i);
      if (!match) continue;
      i += match[0].length - 1;
      const key = match[1],
        n = Math.max(-32768, Math.min(32767, Number(match[2] ?? 1)));
      if (
        [
          "fonttbl",
          "colortbl",
          "stylesheet",
          "info",
          "pict",
          "object",
          "header",
          "footer",
          "filetbl",
          "datastore",
          "fldinst",
        ].includes(key)
      ) {
        state.skip = true;
        continue;
      }
      if (key === "bin") {
        const count = Number(match[2]);
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > source.length - i - 1
        )
          throw new Error("Invalid RTF binary payload");
        i += count;
        continue;
      }
      if (state.skip) continue;
      if (key === "u") {
        text += String.fromCharCode(n < 0 ? n + 65536 : n);
        fallback = state.uc;
      } else if (key === "uc") state.uc = Math.max(0, Math.min(8, n));
      else if (key === "par" || key === "page") paragraph();
      else if (key === "line") text += "\n";
      else if (key === "tab") text += "\t";
      else if (key === "b") state.style.fontWeight = n ? 700 : 400;
      else if (key === "i") state.style.fontStyle = n ? "italic" : "normal";
      else if (key === "ul")
        state.style.textDecoration = n ? "underline" : "none";
      else if (key === "ulnone") state.style.textDecoration = "none";
      else if (key === "strike")
        state.style.textDecoration = n ? "line-through" : "none";
      else if (key === "fs")
        state.style.fontSize = Math.max(6, Math.min(160, (n * 2) / 3));
      else if (key === "cf") state.style.color = colors[n];
      else if (key === "highlight") state.style.backgroundColor = colors[n];
      else if (key === "plain") state.style = {};
      else if (key === "pard") state.paragraph = {};
      else if (["ql", "qr", "qc", "qj"].includes(key))
        state.paragraph.textAlign = (
          { ql: "left", qr: "right", qc: "center", qj: "justify" } as const
        )[key as "ql"];
      else if (["li", "ri", "fi", "sb", "sa"].includes(key))
        Object.assign(state.paragraph, {
          [(
            {
              li: "marginLeft",
              ri: "marginRight",
              fi: "textIndent",
              sb: "marginTop",
              sa: "marginBottom",
            } as const
          )[key as "li"]]: Math.max(-240, Math.min(240, n / 15)),
        });
    } else if (!state.skip && ch !== "\r" && ch !== "\n") {
      if (fallback) fallback--;
      else text += ch;
      if (text.length >= 16_384) flush();
    }
  }
  paragraph();
  return {
    blocks,
    width: 794,
    height: 1123,
    padding: [48, 48, 48, 48],
    truncated: budget.truncated || blocks.length >= 2000 || budget.nodes <= 0,
  };
}
