#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const chunksRoot = resolve(".next/static/chunks");

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}

if (!existsSync(chunksRoot)) {
  throw new Error("Missing .next/static/chunks; cannot verify the ML-KEM bundle");
}

const chunks = javascriptFiles(chunksRoot).map((path) => ({
  path,
  source: readFileSync(path, "utf8"),
}));
const mlKemChunks = chunks.filter(
  ({ source }) => source.includes("RBGstrength") && source.includes("3329"),
);
const brokenChunks = chunks.filter(({ source }) =>
  /Math\.pow\s*\(\s*BigInt/.test(source),
);

if (mlKemChunks.length === 0) {
  throw new Error("ML-KEM implementation is missing from the production bundle");
}
if (brokenChunks.length > 0) {
  throw new Error(
    `Unsafe BigInt Math.pow transform found in: ${brokenChunks.map(({ path }) => path).join(", ")}`,
  );
}

console.log(`[ML-KEM] production bundle verified (${mlKemChunks.length} chunk(s))`);
