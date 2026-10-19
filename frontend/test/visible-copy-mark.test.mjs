import assert from "node:assert/strict"
import test from "node:test"
import sharp from "sharp"
import {
  copyMarkerGrid,
  detectVisibleCopyMarks,
  visibleCopyToken,
} from "../src/utils/visibleCopyMark.util.ts"
import { forensicDecision } from "../src/utils/forensicDecision.util.ts"

const ids = ["1".repeat(32), "2".repeat(32)]
const key = new Uint8Array(32).fill(39)
const candidate = async (index = 0, teamKey = key) => ({
  markId: ids[index],
  pattern: new Float32Array(128 * 128),
  visibleToken: await visibleCopyToken(teamKey, ids[index]),
})
function codeImage(token, left = 570, top = 200) {
  const width = 800,
    height = 1000
  const pixels = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  }
  const grid = copyMarkerGrid(token)
  for (let y = 0; y < grid.size; y++)
    for (let x = 0; x < grid.size; x++)
      if (grid.dark(x, y))
        for (let dy = 0; dy < 3; dy++)
          for (let dx = 0; dx < 3; dx++) {
            const offset =
              ((top + (y + 4) * 3 + dy) * width + left + (x + 4) * 3 + dx) * 4
            pixels.data.fill(48, offset, offset + 3)
          }
  return pixels
}
function perspective(source) {
  const width = 1000,
    height = 1200
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = (x - 40 - 0.025 * y) / (1 + 0.00012 * y)
      const sy = (y - 25) / (1 + 0.00012 * y)
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 + 1 >= source.width || y0 + 1 >= source.height)
        continue
      const fx = sx - x0,
        fy = sy - y0
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => source.data[(yy * source.width + xx) * 4 + c]
        data[(y * width + x) * 4 + c] =
          (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
          fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1))
      }
    }
  return { width, height, data }
}

test("a visible code is copy/team specific and cannot be replaced with an invented tag", async () => {
  const expected = await candidate()
  const pixels = codeImage(expected.visibleToken)
  assert.deepEqual(detectVisibleCopyMarks(pixels, [expected]), [ids[0]])
  assert.deepEqual(detectVisibleCopyMarks(pixels, [await candidate(1)]), [])
  assert.deepEqual(
    detectVisibleCopyMarks(pixels, [
      await candidate(0, new Uint8Array(32).fill(40)),
    ]),
    [],
  )
  assert.deepEqual(
    detectVisibleCopyMarks(codeImage(`PC1:${ids[0]}:${"0".repeat(32)}`), [
      expected,
    ]),
    [],
  )
})

test("visible codes recover through synthetic perspective and JPEG Q20", async () => {
  const expected = await candidate()
  const warped = perspective(codeImage(expected.visibleToken))
  assert.deepEqual(detectVisibleCopyMarks(warped, [expected]), [ids[0]])
  const bytes = await sharp(Buffer.from(warped.data), {
    raw: { width: warped.width, height: warped.height, channels: 4 },
  })
    .jpeg({ quality: 20 })
    .toBuffer()
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.deepEqual(
    detectVisibleCopyMarks(
      {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data),
      },
      [expected],
    ),
    [ids[0]],
  )
})

test("visible evidence has its own verdict and competing markers cannot designate a unique copy", () => {
  const empty = {
    best: null,
    status: "inconclusive",
    compatible: [],
    topScore: 0,
    runnerUpScore: 0,
    rotation: 0,
    scales: [],
  }
  assert.deepEqual(
    forensicDecision([{ analysis: { ...empty, visibleMarkIds: [ids[0]] } }]),
    { kind: "visible_marker", markId: ids[0] },
  )
  assert.deepEqual(
    forensicDecision([{ analysis: { ...empty, visibleMarkIds: ids } }]),
    { kind: "ambiguous", compatibleCount: 2 },
  )
  assert.deepEqual(
    forensicDecision([
      {
        analysis: {
          ...empty,
          compatible: [{ markId: ids[1], score: 9 }],
          visibleMarkIds: [ids[0]],
        },
      },
    ]),
    { kind: "ambiguous", compatibleCount: 2 },
  )
})
