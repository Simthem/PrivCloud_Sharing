import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMark, embedMark, markPattern, MARK_DETECTION_THRESHOLD } from "./watermark.ts";

const sha = value => createHash("sha256").update(value).digest("hex");
/** A report is a plain .json name in the current directory, never a path elsewhere. */
function reportPath(argument) {
  const name = path.basename(argument);
  assert.ok(name === argument && name.endsWith(".json"), "Name a .json report in the current directory");
  return path.join(process.cwd(), name);
}
/** Seeded synthetic pages: a reproducible exploratory corpus, not production calibration. */
function page(seed, width = 320, height = 256) {
  const data = new Uint8ClampedArray(width * height * 4);
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const base = 120 + random() * 90;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = base + 15 * Math.sin(x / 17) + 10 * Math.cos(y / 13) + (random() - 0.5) * 20;
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { data, width, height };
}
export async function runCorpus(trials = 1000) {
  if (!Number.isSafeInteger(trials) || trials < 30 || trials > 10000) throw new Error("Trial budget must be 30..10000");
  const cases = [];
  for (let i = 0; i < trials; i++) {
    const seed = Number.parseInt(sha(`evaluation-image-v1:${i}`).slice(0, 8), 16);
    const key = new Uint8Array(Buffer.from(sha(`evaluation-key-v1:${i}`), "hex"));
    const foreignKey = new Uint8Array(Buffer.from(sha(`foreign-team-key-v1:${i}`), "hex"));
    const ids = Array.from({ length: 8 }, (_, j) => sha(`evaluation-copy-v1:${i}:${j}`).slice(0, 32));
    const candidates = await Promise.all(ids.map(async markId => ({ markId, pattern: await markPattern(key, markId) })));
    const pixels = page(seed);
    const control = ["unmarked", "other-team", "wrong-candidates"][i % 3];
    if (control === "other-team") embedMark(pixels, await markPattern(foreignKey, ids[0]));
    if (control === "wrong-candidates") embedMark(pixels, await markPattern(key, sha(`absent-copy:${i}`).slice(0, 32)));
    const start = performance.now();
    const analysis = detectMark(pixels, candidates);
    cases.push({ seed, control, pixelSha256: sha(pixels.data), matched: analysis.best?.markId ?? null,
      topScore: analysis.topScore, runnerUpScore: analysis.runnerUpScore, elapsedMs: Math.round(performance.now() - start) });
    if (i % 50 === 0) console.log(`corpus ${i}/${trials}`);
  }
  const falseMatches = cases.filter(c => c.matched).length;
  const report = { format: "privcloud-forensic-negative-corpus-v1", generatedAt: new Date().toISOString(),
    algorithmSha256: sha(await readFile(new URL("watermark.ts", import.meta.url))),
    corpusGeneratorSha256: sha(await readFile(new URL(import.meta.url))),
    node: process.version, candidateCount: 8, trials, falseMatches, observedFpr: falseMatches / trials,
    zeroFailureOneSided95Upper: falseMatches === 0 ? 1 - 0.05 ** (1 / trials) : null,
    threshold: MARK_DETECTION_THRESHOLD, split: "evaluation-only; threshold frozen before this corpus",
    limitations: ["Synthetic 320x256 textures only, not independent real documents or photographs.",
      "No production FPR guarantee, ROC/TPR or attribution probability can be inferred.",
      "The upper bound assumes independent Bernoulli trials and does not cover population or distribution shift.",
      "A separate representative calibration set and 100/1000-candidate evaluation remain necessary."], cases };
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runCorpus(Number(process.argv[3] || 1000));
  await writeFile(reportPath(process.argv[2] || "corpus-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`false matches: ${report.falseMatches}/${report.trials}`);
  if (report.falseMatches) process.exitCode = 1;
}
