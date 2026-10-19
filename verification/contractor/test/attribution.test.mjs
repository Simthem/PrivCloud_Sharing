import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { detectMark, embedMark, markPattern } from "../watermark.ts"
import { blurred } from "../benchmark.mjs"

const ids = Array.from({ length: 8 }, (_, i) =>
  createHash("sha256")
    .update(`collusion-holdout:${i}`)
    .digest("hex")
    .slice(0, 32),
)
const key = new Uint8Array(
  createHash("sha256").update("public-collusion-holdout-v1").digest(),
)
const candidates = await Promise.all(
  ids.map(async (markId) => ({
    markId,
    pattern: await markPattern(key, markId),
  })),
)
function page(index) {
  const pixels = {
    width: 512,
    height: 512,
    data: new Uint8ClampedArray(512 * 512 * 4).fill(255),
  }
  for (let offset = 0; offset < pixels.data.length; offset += 4)
    pixels.data[offset] =
      pixels.data[offset + 1] =
      pixels.data[offset + 2] =
        180
  embedMark(pixels, candidates[index].pattern)
  return pixels
}

test("two strong patterns cannot produce a unique match even with a large score gap", () => {
  for (const proportion of [0.35, 0.5, 0.65]) {
    const first = page(0),
      second = page(1)
    for (let offset = 0; offset < first.data.length; offset++)
      first.data[offset] =
        proportion * first.data[offset] + (1 - proportion) * second.data[offset]
    const result = detectMark(first, candidates)
    assert.equal(result.best, null)
    assert.equal(result.status, "ambiguous_multiple_sources")
    assert.deepEqual(
      new Set(result.compatible.map((candidate) => candidate.markId)),
      new Set(ids.slice(0, 2)),
    )
  }
})

test("two-copy mosaics retain both compatible contributors without naming either", () => {
  for (const fraction of [0.35, 0.5, 0.65]) {
    const first = page(0),
      second = page(1)
    for (let offset = 0; offset < first.data.length; offset++)
      if (Math.floor(offset / 4) % first.width > first.width * fraction)
        first.data[offset] = second.data[offset]
    const result = detectMark(first, candidates)
    assert.equal(result.best, null)
    assert.equal(result.status, "ambiguous_multiple_sources")
    assert.deepEqual(
      new Set(result.compatible.map((candidate) => candidate.markId)),
      new Set(ids.slice(0, 2)),
    )
  }
})

test("the ambiguity rule still accepts an isolated positive pattern", () => {
  const result = detectMark(page(3), candidates)
  assert.equal(result.status, "match")
  assert.equal(result.best?.markId, ids[3])
  assert.equal(result.compatible.length, 1)
})

test("Gaussian blur at sigma 0.5 actually changes the fixture pixels", async () => {
  const original = page(0)
  const output = await blurred(original, 0.5)
  assert.equal(output.width, original.width)
  assert.equal(output.height, original.height)
  assert.notDeepEqual(output.data, original.data)
})
