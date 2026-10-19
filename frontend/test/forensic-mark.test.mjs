import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

const mark = () => import("../src/utils/forensicMark.util.ts")

test("native-scale narrow captures retain their mark after small rotations", async () => {
  const { markPattern, embedMark, detectMark } = await mark()
  const { default: sharp } = await import("sharp")
  const key = new Uint8Array(32).fill(29)
  const list = await Promise.all(
    ["1", "2", "3", "4"].map(async (digit) => {
      const markId = digit.repeat(32)
      return { markId, pattern: await markPattern(key, markId) }
    }),
  )
  for (const [width, height] of [
    [743, 159],
    [418, 159],
    [464, 658],
    [320, 256],
  ]) {
    const page = documentPage(width, height)
    embedMark(page, list[0].pattern)
    assert.equal(
      detectMark(page, list).best?.markId,
      list[0].markId,
      `${width}x${height} native`,
    )
    for (const angle of [-2, 2]) {
      const { data, info } = await sharp(Buffer.from(page.data), {
        raw: { width, height, channels: 4 },
      })
        .rotate(angle, { background: "white" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const result = detectMark(
        {
          width: info.width,
          height: info.height,
          data: new Uint8ClampedArray(data),
        },
        list,
      )
      assert.equal(
        result.best?.markId,
        list[0].markId,
        `${width}x${height}, ${angle} degrees`,
      )
    }
  }
})

test("ambiguous candidate patterns never name either copy", async () => {
  const { markPattern, embedMark, detectMark } = await mark()
  const key = new Uint8Array(32).fill(17)
  const markId = "1".repeat(32),
    otherId = "2".repeat(32)
  const pattern = await markPattern(key, markId)
  const pixels = documentPage(900, 1300)
  embedMark(pixels, pattern)
  const result = detectMark(pixels, [
    { markId, pattern },
    { markId: otherId, pattern },
  ])
  assert.equal(result.status, "ambiguous_multiple_sources")
  assert.equal(result.compatible.length, 2)
  assert.equal(result.best, null)
})

test("invalid images and unbounded candidate lists fail before detection", async () => {
  const { detectMark } = await mark()
  assert.throws(() =>
    detectMark({ width: 5000, height: 5000, data: new Uint8Array(0) }, []),
  )
  assert.throws(() =>
    detectMark({ width: 1, height: 1, data: new Uint8Array(3) }, []),
  )
  assert.throws(() =>
    detectMark(
      { width: 1, height: 1, data: new Uint8Array(4) },
      new Array(1001).fill({}),
    ),
  )
})

/** A white page with paragraphs of dark strokes, a heading and a table. */
function documentPage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const fill = (x0, y0, w, h, value) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * 4
        data[i] = data[i + 1] = data[i + 2] = value
      }
    }
  }
  fill(60, 50, 500, 30, 20)
  for (let line = 0; line < 30; line++) {
    for (let word = 0; word < 12; word++) {
      fill(60 + word * 62 + ((line * 7) % 11), 120 + line * 30, 48, 12, 30)
    }
  }
  fill(60, 1060, 700, 200, 232)
  return { data, width, height }
}

/** Bilinear resampling, the way a screenshot of a zoomed page ends up. */
function resize(image, scale) {
  const width = Math.round(image.width * scale)
  const height = Math.round(image.height * scale)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1.001, (y + 0.5) / scale - 0.5)
    const y0 = Math.max(0, Math.floor(sy))
    const fy = sy - y0
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1.001, (x + 0.5) / scale - 0.5)
      const x0 = Math.max(0, Math.floor(sx))
      const fx = sx - x0
      for (let c = 0; c < 4; c++) {
        const at = (xx, yy) => image.data[(yy * image.width + xx) * 4 + c]
        data[(y * width + x) * 4 + c] =
          (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
          fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1))
      }
    }
  }
  return { data, width, height }
}

function crop(image, left, top, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const start = ((top + y) * image.width + left) * 4
    data.set(image.data.subarray(start, start + width * 4), y * width * 4)
  }
  return { data, width, height }
}

async function candidates(key, count) {
  const { markPattern, newMarkId } = await mark()
  const list = []
  for (let i = 0; i < count; i++) {
    const markId = newMarkId()
    list.push({ markId, pattern: await markPattern(key, markId) })
  }
  return list
}

test("each copy has its own pattern, fixed by the key and the mark id", async () => {
  const { markPattern, isMarkId, newMarkId, MARK_TILE } = await mark()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const id = newMarkId()
  assert.equal(isMarkId(id), true)
  assert.equal(isMarkId("../x"), false)
  const pattern = await markPattern(key, id)
  assert.equal(pattern.length, MARK_TILE * MARK_TILE)
  assert.deepEqual(await markPattern(key, id), pattern)
  assert.notDeepEqual(await markPattern(key, newMarkId()), pattern)
  const otherKey = crypto.getRandomValues(new Uint8Array(32))
  assert.notDeepEqual(await markPattern(otherKey, id), pattern)
  assert.ok(pattern.every((value) => value >= -1 && value <= 1))
  await assert.rejects(markPattern(key.subarray(0, 16), id))
})

test("the mark changes a page by a few levels at most", async () => {
  const { embedMark, markPattern, newMarkId, MARK_AMPLITUDE } = await mark()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const page = documentPage(400, 300)
  const before = new Uint8ClampedArray(page.data)
  embedMark(page, await markPattern(key, newMarkId()))
  let max = 0
  for (let i = 0; i < before.length; i++) {
    if (i % 4 === 3) {
      assert.equal(page.data[i], before[i])
      continue
    }
    max = Math.max(max, Math.abs(page.data[i] - before[i]))
  }
  assert.ok(max <= 2 * MARK_AMPLITUDE)
  assert.ok(max > 0)
})

test("a reduced and cropped capture still names its copy", async () => {
  const { detectMark, embedMark, MARK_DETECTION_THRESHOLD } = await mark()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const list = await candidates(key, 6)
  const page = documentPage(900, 1300)
  embedMark(page, list[2].pattern)
  const capture = crop(resize(page, 0.62), 40, 90, 480, 520)
  const analysis = detectMark(capture, list)
  assert.equal(analysis.best?.markId, list[2].markId)
  assert.ok(analysis.best.score >= MARK_DETECTION_THRESHOLD)
  assert.ok(analysis.runnerUpScore < MARK_DETECTION_THRESHOLD)
  assert.ok(Math.abs(analysis.best.scale - 0.62) < 0.01)
  assert.ok(analysis.best.falseMatchLog10 < -10)
})

test("a capture reduced then enlarged into a PDF page is still named", async () => {
  const { detectMark, embedMark } = await mark()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const list = await candidates(key, 4)
  const page = documentPage(900, 1300)
  embedMark(page, list[1].pattern)
  // Screenshot at 57 %, then drawn about twice as large by a PDF renderer:
  // the period found first is often the double of the true one.
  const rendered = resize(resize(page, 0.57), 2.09)
  const analysis = detectMark(rendered, list)
  assert.equal(analysis.best?.markId, list[1].markId)
  assert.ok(Math.abs(analysis.best.scale - 0.57 * 2.09) < 0.02)
})

test("no copy is named without the mark or without the key", async () => {
  const { detectMark, embedMark } = await mark()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const clean = documentPage(900, 1300)
  assert.equal(detectMark(clean, await candidates(key, 6)).best, null)
  const marked = documentPage(900, 1300)
  const real = await candidates(key, 1)
  embedMark(marked, real[0].pattern)
  // Another team, same mark id: another pattern.
  const { markPattern } = await mark()
  const otherKey = crypto.getRandomValues(new Uint8Array(32))
  const foreign = [
    {
      markId: real[0].markId,
      pattern: await markPattern(otherKey, real[0].markId),
    },
  ]
  assert.equal(detectMark(marked, foreign).best, null)
  assert.equal(detectMark(marked, real).best?.markId, real[0].markId)
})

test("the original is hashed in chunks like a single SHA-256", async () => {
  const { Sha256, hashPreviewSource, sha256Hex } =
    await import("../src/utils/sha256Stream.util.ts")
  for (const size of [0, 55, 56, 64, 1000, 3 * 1024 * 1024 + 7]) {
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + size) & 255
    const expected = createHash("sha256").update(bytes).digest("hex")
    assert.equal(new Sha256().update(bytes).digestHex(), expected)
    assert.equal(await sha256Hex(bytes), expected)
    const source = {
      size,
      read: async (start, end) => bytes.slice(start, end),
    }
    assert.equal(await hashPreviewSource(source), expected)
  }
})
