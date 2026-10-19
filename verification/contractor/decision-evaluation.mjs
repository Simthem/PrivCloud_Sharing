import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { detectMark, embedMark, markPattern, MARK_DETECTION_THRESHOLD } from "./watermark.ts"

const sha = value => createHash("sha256").update(value).digest("hex")
function background(index) {
  const width = index % 3 === 0 ? 512 : 320, height = index % 3 === 0 ? 384 : 256
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  let seed = Number.parseInt(sha(`decision-holdout-image:${index}`).slice(0, 8), 16)
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    const value = index % 2 ? 165 + 22 * Math.sin(x / 19) + 16 * Math.cos(y / 23) + random() * 15
      : x > 24 && x < width - 24 && y % 31 < 5 ? 30 : 220
    data[offset] = data[offset + 1] = data[offset + 2] = value
  }
  return { width, height, data }
}

export async function runDecisionEvaluation() {
  const cases = []
  for (const count of [8, 100, 1000]) {
    const key = new Uint8Array(Buffer.from(sha(`decision-holdout-team:${count}`), "hex"))
    const candidates = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const markId = sha(`decision-holdout-copy:${count}:${index}`).slice(0, 32)
      return { markId, pattern: await markPattern(key, markId) }
    }))
    for (let index = 0; index < 33; index++) {
      const pixels = background(index)
      const control = index < 30 ? ["unmarked", "other-team", "absent-copy"][index % 3]
        : ["positive", "two-copy-average", "two-copy-mosaic"][index - 30]
      if (control === "other-team") embedMark(pixels, await markPattern(
        new Uint8Array(Buffer.from(sha(`decision-foreign-team:${index}`), "hex")), candidates[0].markId,
      ))
      if (control === "absent-copy") embedMark(pixels, await markPattern(key, sha(`decision-absent:${index}`).slice(0, 32)))
      if (index >= 30) {
        const second = { ...pixels, data: new Uint8ClampedArray(pixels.data) }
        embedMark(pixels, candidates[0].pattern)
        if (control !== "positive") {
          embedMark(second, candidates[1].pattern)
          for (let offset = 0; offset < pixels.data.length; offset++) {
            if (control === "two-copy-average") pixels.data[offset] = (pixels.data[offset] + second.data[offset]) / 2
            else if (Math.floor(offset / 4) % pixels.width > pixels.width / 2) pixels.data[offset] = second.data[offset]
          }
        }
      }
      const at = performance.now(), result = detectMark(pixels, candidates)
      const expectedStatus = index < 30 ? "inconclusive" : control === "positive" ? "match" : "ambiguous_multiple_sources"
      const allowedIds = new Set(index < 30 ? [] : candidates.slice(0, control === "positive" ? 1 : 2).map(candidate => candidate.markId))
      cases.push({ count, index, control, width: pixels.width, height: pixels.height,
        pixelSha256: sha(pixels.data), expectedStatus, status: result.status,
        matched: result.best?.markId ?? null, compatible: result.compatible,
        correct: result.status === expectedStatus && result.compatible.every(candidate => allowedIds.has(candidate.markId)),
        safeDecision: index < 30 ? result.compatible.length === 0
          : control === "positive" ? result.best?.markId === candidates[0].markId
          : result.best === null && result.compatible.every(candidate => allowedIds.has(candidate.markId)),
        elapsedMs: Math.round(performance.now() - at), processRssAfterBytes: process.memoryUsage().rss,
        patternBytes: count * 128 * 128 * 4, topScore: result.topScore, runnerUpScore: result.runnerUpScore })
      if (index % 10 === 0) console.log(`decision holdout: ${count} candidates, ${index}/33`)
    }
  }
  const groups = [8, 100, 1000].map(count => {
    const negative = cases.filter(c => c.count === count && c.index < 30)
    const falseMatches = negative.filter(c => c.matched).length
    return { count, trials: negative.length, falseMatches,
      falsePlausibleSignals: negative.filter(c => c.compatible.length).length,
      zeroFailureOneSided95Upper: falseMatches ? null : 1 - 0.05 ** (1 / negative.length) }
  })
  return { format: "privcloud-decision-holdout-v1", generatedAt: new Date().toISOString(),
    algorithmSha256: sha(await readFile(new URL("watermark.ts", import.meta.url))),
    generatorSha256: sha(await readFile(new URL(import.meta.url))), node: process.version,
    threshold: MARK_DETECTION_THRESHOLD, groups, cases,
    limitations: ["New synthetic evaluation seeds, not representative real photographs or a production calibration.",
      "Only 30 negatives and three decision controls per candidate count; no production attribution probability.",
      "The upper bound assumes independent Bernoulli trials and is conditional on the synthetic distribution.",
      "RSS is observed after a call in this Node process, not peak worker/browser memory or device performance.",
      "Elapsed times can be affected by other local validation tasks. The threshold was not tuned on these cases."] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runDecisionEvaluation()
  await writeFile(new URL("decision-evaluation-results.json", import.meta.url), JSON.stringify(report, null, 2) + "\n")
  assert.ok(report.cases.every(c => c.safeDecision), "Unsafe decision in holdout evaluation; report retained")
  console.log(`Expected detection decisions: ${report.cases.filter(c => c.correct).length}/${report.cases.length}. Safe decisions: ${report.cases.filter(c => c.safeDecision).length}/${report.cases.length}`)
}
