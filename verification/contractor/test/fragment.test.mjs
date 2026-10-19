import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { runFragmentBenchmark } from "../fragment-benchmark.mjs"
import { detectFragmentCopyMark } from "../fragment-copy-mark.ts"

test("fixed-scale fragment search recovers short crops without uniquely attributing mixtures", { timeout: 90_000 }, async () => {
  const report = await runFragmentBenchmark(3)
  assert.ok(report.cases.slice(0, 3).every(item => item.correct))
  assert.ok(report.cases.slice(3, 6).every(item => item.status !== "match"))
  assert.equal(report.negativeControls.uniqueMatches, 0)
  assert.equal(report.negativeControls.ambiguous, 0)
})

test("published fragment report binds the exact algorithm and holdout generator", async () => {
  const report = JSON.parse(await readFile(new URL("../fragment-results.json", import.meta.url)))
  for (const [field, name] of [["algorithmSha256", "fragment-copy-mark.ts"], ["watermarkSha256", "watermark.ts"], ["harnessSha256", "fragment-benchmark.mjs"]])
    assert.equal(report[field], createHash("sha256").update(await readFile(new URL("../" + name, import.meta.url))).digest("hex"))
  assert.equal(report.decisionThreshold, 10)
  assert.equal(report.compatibilityThreshold, 8)
  assert.equal(report.fixedScales, 181)
  assert.equal(report.negativeControls.uniqueMatches, 0)
  assert.equal(report.negativeControls.trials, 100)
})

test("fragment input is bounded and larger candidate lists are never silently truncated", () => {
  const pixels = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) }
  assert.equal(detectFragmentCopyMark(pixels, []), null)
  assert.throws(() => detectFragmentCopyMark({ ...pixels, width: Infinity }, []))
  const candidates = Array.from({ length: 129 }, (_, index) => ({ markId: index.toString(16).padStart(32, "0"), pattern: new Float32Array(16384) }))
  assert.equal(detectFragmentCopyMark({ width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4) }, candidates), null)
})
