import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyAltchaInjectors(source) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf('"altcha-css"', offset)) !== -1) {
    const code = source
      .slice(offset, offset + 1500)
      .split("document.head.appendChild")[0];
    const meta = code.indexOf("meta[name=");
    const current = code.indexOf("document.currentScript");
    if (
      !code.includes('createElement("style")') ||
      meta < 0 ||
      current < meta
    ) {
      throw new Error(
        "Compiled ALTCHA injector does not prioritize the document nonce",
      );
    }
    count++;
    offset += 12;
  }
  return count;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const directory = resolve(".next/static/chunks");
  let count = 0;
  for (const file of readdirSync(directory, { recursive: true })) {
    if (file.endsWith(".js"))
      count += verifyAltchaInjectors(
        readFileSync(join(directory, file), "utf8"),
      );
  }
  if (!count) throw new Error("No compiled ALTCHA injector found to verify");
  console.log(`[ALTCHA] production nonce injector verified (${count})`);
}
