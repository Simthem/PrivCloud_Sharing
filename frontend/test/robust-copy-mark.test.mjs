import assert from "node:assert/strict"
import test from "node:test"
import sharp from "sharp"
import {
  embedRobustCopyMark,
  detectRobustCopyMark,
  combineCopyAnalyses,
} from "../src/utils/robustCopyMark.util.ts"
import { embedMark, markPattern } from "../src/utils/forensicMark.util.ts"

test("the coarse carrier is recovered from a JPEG crop that contains no visible code", async () => {
  const candidates = await Promise.all(
    ["1", "2", "3", "4"].map(async (digit) => {
      const markId = digit.repeat(32)
      return {
        markId,
        pattern: await markPattern(new Uint8Array(32).fill(59), markId),
      }
    }),
  )
  const width = 1191,
    height = 1684
  const pixels = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  }
  embedRobustCopyMark(pixels, candidates[0].pattern)
  embedMark(pixels, candidates[0].pattern)
  const bytes = await sharp(Buffer.from(pixels.data), {
    raw: { width, height, channels: 4 },
  })
    .extract({ left: 195, top: 300, width: 800, height: 1000 })
    .jpeg({ quality: 20 })
    .toBuffer()
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const crop = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  }
  const result = detectRobustCopyMark(crop, candidates)
  assert.equal(
    result?.best?.markId,
    candidates[0].markId,
    JSON.stringify(result),
  )
  assert.equal(detectRobustCopyMark(crop, candidates.slice(1))?.best, null)
  assert.equal(
    detectRobustCopyMark(
      { ...pixels, data: new Uint8ClampedArray(pixels.data.length).fill(255) },
      candidates,
    )?.best,
    null,
  )
})

test("conflicting carriers cannot produce a unique copy attribution", () => {
  const candidate = (digit, score) => ({
    markId: digit.repeat(32),
    score,
    scale: 1,
    falseMatchLog10: -10,
  })
  const analysis = (digit, score) => ({
    status: "match",
    best: candidate(digit, score),
    compatible: [candidate(digit, score)],
    topScore: score,
    runnerUpScore: 4,
    scales: [1],
    rotation: 0,
  })
  const result = combineCopyAnalyses([analysis("1", 20), analysis("2", 12)])
  assert.equal(result.status, "ambiguous_multiple_sources")
  assert.equal(result.best, null)
  assert.equal(result.compatible.length, 2)
  assert.equal(
    combineCopyAnalyses([analysis("1", 20), analysis("1", 12)]).best.markId,
    "1".repeat(32),
  )
  assert.throws(() => combineCopyAnalyses([]))
})

test("the whole-page carrier rejects malformed and oversized pixels before work", () => {
  const invalid = { width: 5000, height: 5000, data: new Uint8ClampedArray(4) }
  assert.throws(() => embedRobustCopyMark(invalid, new Float32Array(128 * 128)))
  assert.throws(() => detectRobustCopyMark(invalid, []))
  assert.throws(() =>
    embedRobustCopyMark(
      { width: 1, height: 1, data: new Uint8ClampedArray(4) },
      new Float32Array(2),
    ),
  )
})
