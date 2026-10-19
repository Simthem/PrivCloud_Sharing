import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import {
  copyMarkerGrid,
  detectVisibleCopyMarks,
  visibleCopyToken,
} from "./visible-copy-mark.ts"

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

export async function runVisibleMarkerBenchmark() {
  const expected = await candidate()
  const original = codeImage(expected.visibleToken)
  const warped = perspective(original)
  const jpeg = await sharp(Buffer.from(warped.data), {
    raw: { width: warped.width, height: warped.height, channels: 4 },
  })
    .jpeg({ quality: 20 })
    .toBuffer()
  const decoded = await sharp(jpeg)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const cases = []
  for (const [name, pixels, candidates, wanted] of [
    ["intact", original, [expected], [ids[0]]],
    ["perspective", warped, [expected], [ids[0]]],
    [
      "perspective-jpeg-q20",
      {
        width: decoded.info.width,
        height: decoded.info.height,
        data: new Uint8ClampedArray(decoded.data),
      },
      [expected],
      [ids[0]],
    ],
    ["wrong-copy", original, [await candidate(1)], []],
    [
      "wrong-team",
      original,
      [await candidate(0, new Uint8Array(32).fill(40))],
      [],
    ],
    [
      "invented-tag",
      codeImage(`PC1:${ids[0]}:${"0".repeat(32)}`),
      [expected],
      [],
    ],
    [
      "unmarked",
      {
        ...original,
        data: new Uint8ClampedArray(original.data.length).fill(255),
      },
      [expected],
      [],
    ],
  ]) {
    const start = performance.now()
    const found = detectVisibleCopyMarks(pixels, candidates)
    assert.deepEqual(found, wanted, name)
    cases.push({
      name,
      width: pixels.width,
      height: pixels.height,
      expectedMarkers: wanted.length,
      foundMarkers: found.length,
      correct: true,
      elapsedMs: Math.round(performance.now() - start),
    })
  }
  const sha = (value) => createHash("sha256").update(value).digest("hex")
  return {
    format: "privcloud-visible-copy-marker-v1",
    generatedAt: new Date().toISOString(),
    markerSha256: sha(
      await readFile(new URL("visible-copy-mark.ts", import.meta.url)),
    ),
    harnessSha256: sha(
      await readFile(new URL("visible-mark-benchmark.mjs", import.meta.url)),
    ),
    algorithm: "privcloud:visible-copy:v1",
    modulePixels: 3,
    errorCorrection: "H",
    cases,
    limits: [
      "Synthetic controls are publicly reproducible. A separate private physical-photo observation is recorded in the published report, not reproduced by this runner.",
      "A new visible marker supplements the unchanged invisible v1 pattern. It cannot repair old copies.",
      "A copied valid code can be transplanted. Marker recovery alone does not authenticate the surrounding image or identify a leaker.",
      "Removing the marker, full OCR reconstruction and recreation from an unmarked original can still erase copy-specific information.",
      "Two fixed image preparations: 1600-pixel bilinear reduction, and 2000-pixel bilinear reduction with a binomial filter. Each inspects one whole-image view and at most 81 overlapping 400-pixel tiles. No general capture or collusion guarantee.",
    ],
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, "Usage: node visible-mark-benchmark.mjs")
  const report = await runVisibleMarkerBenchmark()
  const directory = await mkdtemp(
    path.join(process.cwd(), "visible-mark-report-"),
  )
  await writeFile(
    path.join(directory, "visible-mark-results.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  )
  console.log(`Visible marker report saved in ${directory}`)
}
