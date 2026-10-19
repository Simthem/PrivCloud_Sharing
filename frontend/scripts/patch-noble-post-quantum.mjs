#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_MARKER = "Turbopack-safe modular exponentiation";
const VULNERABLE_POWER =
  /^(?<indent>[ \t]*)const p = BigInt\(ROOT_OF_UNITY\) \*\* BigInt\(b\) % BigInt\(Q\);$/m;
const BIGINT_POWER = /BigInt\(ROOT_OF_UNITY\)\s*\*\*/;

export function patchCrystalsSource(source) {
  if (source.includes(PATCH_MARKER)) {
    return { source, status: "already-patched" };
  }

  const match = source.match(VULNERABLE_POWER);
  if (!match) {
    if (BIGINT_POWER.test(source)) {
      throw new Error(
        "Unsupported @noble/post-quantum BigInt exponentiation shape; refusing an unsafe build",
      );
    }
    return { source, status: "not-needed" };
  }

  const indent = match.groups?.indent ?? "";
  const replacement = [
    `${indent}// ${PATCH_MARKER}: SWC/Turbopack can lower BigInt ** BigInt to Math.pow().`,
    `${indent}const modulus = BigInt(Q);`,
    `${indent}let base = BigInt(ROOT_OF_UNITY) % modulus;`,
    `${indent}let exponent = BigInt(b);`,
    `${indent}let p = 1n;`,
    `${indent}while (exponent > 0n) {`,
    `${indent}    if ((exponent & 1n) === 1n)`,
    `${indent}        p = (p * base) % modulus;`,
    `${indent}    base = (base * base) % modulus;`,
    `${indent}    exponent >>= 1n;`,
    `${indent}}`,
  ].join("\n");

  return {
    source: source.replace(VULNERABLE_POWER, replacement),
    status: "patched",
  };
}

export function patchCrystalsFile(path) {
  const original = readFileSync(path, "utf8");
  const result = patchCrystalsSource(original);
  if (result.status === "patched") writeFileSync(path, result.source, "utf8");
  return result.status;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const require = createRequire(import.meta.url);
  const mlKemEntry = require.resolve("@noble/post-quantum/ml-kem.js");
  const crystalsPath = resolve(dirname(mlKemEntry), "_crystals.js");
  const status = patchCrystalsFile(crystalsPath);
  console.log(`[ML-KEM] @noble/post-quantum build patch: ${status}`);
}
