import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectMark, embedMark, markPattern, estimateDocumentSkew } from "./watermark.ts";

const sha = value => createHash("sha256").update(value).digest("hex");
const [directoryName, outputName] = process.argv.slice(2);
assert.ok(directoryName && outputName, "Usage: node real-corpus.mjs INPUT_DIRECTORY PRIVATE_REPORT.json");
/** Inputs and the report are plain names in the current directory, never paths elsewhere. */
function localPath(argument, pattern) {
  const name = path.basename(argument);
  assert.ok(name === argument && pattern.test(name), "Use plain names in the current directory");
  return path.join(process.cwd(), name);
}
const directory = localPath(directoryName, /^[^.]/), output = localPath(outputName, /\.json$/);
const key = new Uint8Array(Buffer.from(sha("real-background-new-control-pattern-v1"), "hex"));
const candidates = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
  const markId = sha(`real-background-control-copy:${index}`).slice(0, 32);
  return { markId, pattern: await markPattern(key, markId) };
}));
const files = (await readdir(directory)).filter(name => /\.(png|jpe?g|webp)$/i.test(name)).sort();
assert.ok(files.length && files.length <= 200, "Corpus budget: 1..200 images");
const cases = [];
const decode = async bytes => {
  const { data, info } = await sharp(bytes, { limitInputPixels: 16_000_000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};
for (const [index, name] of files.entries()) {
  const file = path.join(directory, name), stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, "Unsafe/oversized corpus file");
  const bytes = await readFile(file), original = await decode(bytes);
  const marked = { ...original, data: new Uint8ClampedArray(original.data) };
  embedMark(marked, candidates[0].pattern);
  const image = () => sharp(Buffer.from(marked.data), { raw: { width: marked.width, height: marked.height, channels: 4 } });
  const variants = [["original-vs-new-candidates", original, null],
    ["new-control-mark", marked, candidates[0].markId],
    ["new-control-jpeg-q60", await decode(await image().jpeg({ quality: 60 }).toBuffer()), candidates[0].markId],
    ["new-control-rotation-2", await decode(await image().rotate(2, { background: "white" }).png().toBuffer()), candidates[0].markId]];
  for (const [control, pixels, expected] of variants) {
    const start = performance.now(), result = detectMark(pixels, candidates), matched = result.best?.markId ?? null;
    cases.push({ imageIndex: index, sourceSha256: sha(bytes), control, expected, matched,
      correct: matched === expected, width: pixels.width, height: pixels.height,
      status: result.status, topScore: result.topScore, rotation: result.rotation,
      estimatedSkew: estimateDocumentSkew(pixels), scales: result.scales,
      elapsedMs: Math.round(performance.now() - start) });
  }
  console.log(`real background ${index + 1}/${files.length} measured`);
}
const report = { format: "privcloud-real-background-control-v1", generatedAt: new Date().toISOString(),
  algorithmSha256: sha(await readFile(new URL("watermark.ts", import.meta.url))), node: process.version,
  imageCount: files.length, cases,
  limitations: ["Existing images may already contain an unrelated production watermark.",
    "Original-vs-new-candidates is a wrong-candidate control, not proof that an image is unmarked.",
    "Positive controls add a NEW known pattern to the supplied background, not recover its existing issued mark.",
    "No production team key, original copy attribution, smartphone photo or PDF-generation fidelity is tested.",
    "Correlated captures from the same documents do not calibrate a population false-positive rate.",
    "No input pixels, filenames or personal data are copied into this report or the public archive."] };
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
assert.ok(cases.every(c => c.matched === null || c.matched === c.expected), "Incorrect attribution; report retained");
