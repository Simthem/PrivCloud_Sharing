import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectMark, embedMark, markPattern } from "./watermark.ts";

const sha = value => createHash("sha256").update(value).digest("hex");
/** A report is a plain .json name in the current directory, never a path elsewhere. */
function reportPath(argument) {
  const name = path.basename(argument);
  assert.ok(name === argument && name.endsWith(".json"), "Name a .json report in the current directory");
  return path.join(process.cwd(), name);
}
const key = new Uint8Array(Buffer.from(sha("candidate-scale-evaluation-v1"), "hex"));
const cases = [];
for (const count of [100, 1000]) {
  const start = performance.now();
  const candidates = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const markId = sha(`candidate-scale-v1:${index}`).slice(0, 32);
    return { markId, pattern: await markPattern(key, markId) };
  }));
  const patternMs = performance.now() - start;
  for (const control of ["positive", "small-positive", "unmarked", "absent-copy"]) {
    const width = control === "positive" ? 1920 : 320, height = control === "positive" ? 1440 : 256;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let p = 0; p < data.length; p += 4) data[p] = data[p + 1] = data[p + 2] = 170;
    const pixels = { data, width, height };
    const expected = control.endsWith("positive") ? candidates[count - 1].markId : null;
    if (expected) embedMark(pixels, candidates[count - 1].pattern);
    if (control === "absent-copy") embedMark(pixels, await markPattern(key, sha("absent-scale-copy").slice(0, 32)));
    const at = performance.now();
    const result = detectMark(pixels, candidates);
    const matched = result.best?.markId ?? null;
    cases.push({ count, control, matched, expected, correct: matched === expected,
      width, height, elapsedMs: Math.round(performance.now() - at), patternMs: Math.round(patternMs),
      patternBytes: count * 128 * 128 * 4, topScore: result.topScore, runnerUpScore: result.runnerUpScore });
    console.log(`${count} candidates, ${control}: ${matched === expected ? "pass" : "fail"}`);
  }
}
const report = { format: "privcloud-candidate-scale-v1", generatedAt: new Date().toISOString(),
  algorithmSha256: sha(await readFile(new URL("watermark.ts", import.meta.url))), node: process.version,
  limitations: ["Eight synthetic controls on constant backgrounds only, 1920x1440 and 320x256.",
    "Not a false-positive calibration or browser/mobile performance guarantee.",
    "Pattern bytes exclude worker structured-clone overhead, FFT buffers and image memory."], cases };
await writeFile(reportPath(process.argv[2] || "candidate-scale-results.json"), JSON.stringify(report, null, 2) + "\n");
assert.ok(cases.every(c => c.matched === null || c.matched === c.expected), "Wrong attribution; report retained");
