import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { embedMark, markPattern } from "./watermark.ts"
import { detectFragmentCopyMark } from "./fragment-copy-mark.ts"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const ids = Array.from({ length: 8 }, (_, index) => hash(`fragment-holdout:${index}`).slice(0, 32))
const key = new Uint8Array(createHash("sha256").update("fragment-holdout-key-v1").digest())
const candidates = await Promise.all(ids.map(async (markId) => ({ markId, pattern: await markPattern(key, markId) })))

async function capture(pattern, index, width = 631, height = 66) {
  const pixels = { width: 1024, height: 512, data: new Uint8ClampedArray(1024 * 512 * 4).fill(255) }
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
    const offset = (y * pixels.width + x) * 4
    const color = 220 + 8 * Math.sin((x + index * 7) / 37) + 6 * Math.cos((y + index) / 61)
    pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = color
    if (y % 47 > 30 && x % 89 > 12 && x % 89 < 70)
      pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = 30
  }
  if (pattern) embedMark(pixels, pattern)
  const { data, info } = await sharp(Buffer.from(pixels.data), { raw: { width: pixels.width, height: pixels.height, channels: 4 } })
    .resize(686, 343, { kernel: "lanczos3" })
    .extract({ left: index % 41, top: 50 + index % 40, width, height })
    .png().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
}

export async function runFragmentBenchmark(negativeCount = 100) {
  const cases = []
  const measure = async (name, pixels, expected = null, compatible = null) => {
    const start = performance.now()
    const result = detectFragmentCopyMark(pixels, candidates)
    const correct = compatible
      ? result?.status === "ambiguous_multiple_sources" && compatible.every(id => result.compatible.some(item => item.markId === id))
      : expected ? result?.best?.markId === expected : !result?.best && result?.status !== "ambiguous_multiple_sources"
    cases.push({ name, width: pixels.width, height: pixels.height, expected, status: result?.status ?? "ineligible", correct, score: result?.topScore ?? 0, second: result?.runnerUpScore ?? 0, elapsedMs: Math.round(performance.now() - start) })
    return correct
  }
  for (const [width, height] of [[631, 66], [113, 135], [239, 135]])
    assert.ok(await measure(`marked-${width}x${height}`, await capture(candidates[0].pattern, 0, width, height), ids[0]))
  for (const weight of [0.35, 0.5, 0.65]) {
    const first = await capture(candidates[0].pattern, 0, 398, 135)
    const second = await capture(candidates[1].pattern, 0, 398, 135)
    for (let i = 0; i < first.data.length; i++) first.data[i] = weight * first.data[i] + (1 - weight) * second.data[i]
    await measure(`two-source-${weight}`, first, null, ids.slice(0, 2))
    assert.notEqual(cases.at(-1).status, "match")
  }
  for (let index = 0; index < negativeCount; index++) {
    const pattern = index % 3 === 0 ? null : await markPattern(
      index % 3 === 1 ? key : new Uint8Array(32).fill(172),
      index % 3 === 1 ? hash(`foreign-copy:${index}`).slice(0, 32) : ids[index % ids.length],
    )
    await measure(`negative-${index}`, await capture(pattern, index, index % 2 ? 113 : 631, index % 2 ? 135 : 66))
    if ((index + 1) % 20 === 0) console.log(`Fragment controls: ${index + 1}/${negativeCount}`)
  }
  return {
    generatedAt: new Date().toISOString(),
    algorithmSha256: hash(await readFile(new URL("./fragment-copy-mark.ts", import.meta.url))),
    watermarkSha256: hash(await readFile(new URL("./watermark.ts", import.meta.url))),
    harnessSha256: hash(await readFile(new URL(import.meta.url))),
    decisionThreshold: 10, compatibilityThreshold: 8, fixedScales: 181, candidateCount: candidates.length,
    negativeControls: { trials: negativeCount, uniqueMatches: cases.filter(item => item.name.startsWith("negative-") && item.status === "match").length, ambiguous: cases.filter(item => item.name.startsWith("negative-") && item.status === "ambiguous_multiple_sources").length },
    limitation: "Synthetic holdout with eight candidates. Neither a production false-attribution rate nor real-phone population validation. Correlated crops are not independent trials. The analytic score tail is not an empirical probability.",
    cases,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runFragmentBenchmark()
  await writeFile(new URL("./fragment-results.json", import.meta.url), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ positives: report.cases.slice(0, 3), negativeControls: report.negativeControls }))
  assert.equal(report.negativeControls.uniqueMatches, 0)
  assert.equal(report.negativeControls.ambiguous, 0)
}
