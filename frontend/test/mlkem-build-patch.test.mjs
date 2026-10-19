import assert from "node:assert/strict";
import test from "node:test";

import { patchCrystalsSource } from "../scripts/patch-noble-post-quantum.mjs";

test("replaces BigInt exponentiation with Turbopack-safe modular exponentiation", () => {
  const vulnerable = [
    "function getZettas() {",
    "    const p = BigInt(ROOT_OF_UNITY) ** BigInt(b) % BigInt(Q);",
    "    return Number(p);",
    "}",
  ].join("\n");

  const patched = patchCrystalsSource(vulnerable);
  assert.equal(patched.status, "patched");
  assert.doesNotMatch(patched.source, /BigInt\(ROOT_OF_UNITY\)\s*\*\*/);
  assert.match(patched.source, /Turbopack-safe modular exponentiation/);

  const repeated = patchCrystalsSource(patched.source);
  assert.equal(repeated.status, "already-patched");
  assert.equal(repeated.source, patched.source);
});

test("fails closed when a vulnerable expression changes unexpectedly", () => {
  assert.throws(
    () =>
      patchCrystalsSource(
        "const p = BigInt(ROOT_OF_UNITY) ** BigInt(otherExponent);",
      ),
    /refusing an unsafe build/,
  );
});
