import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "Document-scoped ALTCHA CSS nonce";
const injection =
  /function injectCss\(css2, id = "altcha-css", nonce\) \{[\s\S]*?\n\}/;

export function patchAltchaCss(source) {
  const match = source.match(injection);
  if (
    !match ||
    ![
      'document.createElement("style")',
      "style.id = id;",
      "style.textContent = css2;",
      "document.head.appendChild(style);",
    ].every((part) => match[0].includes(part))
  ) {
    throw new Error(
      "Unsupported ALTCHA CSS injector. Refusing an unverified build",
    );
  }
  const replacement = `function injectCss(css2, id = "altcha-css", nonce) {
  // ${marker}
  if (typeof document !== "undefined" && document && !document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css2;
    const resolvedNonce = document.querySelector('meta[name="csp-nonce"]')?.content || nonce || document.currentScript?.nonce;
    if (resolvedNonce) style.nonce = resolvedNonce;
    document.head.appendChild(style);
  }
}`;
  return source.replace(injection, replacement);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve("altcha"));
  for (const file of [
    "altcha.js",
    "altcha.umd.cjs",
    "altcha.i18n.js",
    "altcha.i18n.umd.cjs",
  ]) {
    const target = resolve(directory, file);
    const original = readFileSync(target, "utf8");
    const patched = patchAltchaCss(original);
    if (patched !== original) writeFileSync(target, patched, "utf8");
  }
  console.log("[ALTCHA] document-scoped CSS nonce verified");
}
