import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
  frontendRoot,
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
);
const destination = resolve(frontendRoot, "public/pdf.worker.min.mjs");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log("[PDF] Local PDF.js worker prepared");
