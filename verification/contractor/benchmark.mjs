import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import {
  markPattern,
  embedMark,
  detectMark,
  MARK_DETECTION_THRESHOLD,
} from "./watermark.ts"
import { screenshot } from "./screenshot.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
export function fixture(kind, width = 1920, height = 1440) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  let seed = 0x51f15e
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  if (kind === "texture") {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4
        for (let c = 0; c < 3; c++)
          data[p + c] =
            140 +
            35 * Math.sin(x / 73 + c) +
            30 * Math.cos(y / 61 + c) +
            random() * 18
      }
  }
  const fill = (x0, y0, w, h, value) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++)
      for (let x = x0; x < Math.min(width, x0 + w); x++) {
        const p = (y * width + x) * 4
        data[p] = data[p + 1] = data[p + 2] = value
      }
  }
  if (kind === "gray") fill(0, 0, width, height, 220)
  fill(100, 65, 900, 35, 30)
  for (let line = 0; line < 35; line++)
    for (let word = 0; word < 18; word++)
      fill(
        100 + word * 85 + (line % 9),
        160 + line * 29,
        50 + (word % 5) * 4,
        12,
        30,
      )
  for (let y = 1210; y < 1400; y += 50) fill(100, y, 1650, 2, 50)
  for (let x = 100; x < 1800; x += 330) fill(x, 1210, 2, 190, 50)
  return { data, width, height }
}
const image = (pixels) =>
  sharp(Buffer.from(pixels.data), {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  })
const decode = async (buffer) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height,
  }
}
const transformed = async (pipeline) => decode(await pipeline.png().toBuffer())
const clone = (p) => ({ ...p, data: new Uint8ClampedArray(p.data) })
export const measure = (pixels, candidates, expected) => {
  const start = performance.now(),
    result = detectMark(pixels, candidates)
  return {
    detected: result.best?.markId === expected,
    matched: result.best?.markId ?? null,
    score: result.best?.score ?? null,
    topScore: result.topScore,
    status: result.status,
    compatible: result.compatible,
    rotation: result.rotation,
    runnerUpScore: result.runnerUpScore,
    scale: result.best?.scale ?? null,
    elapsedMs: Math.round(performance.now() - start),
    pixelSha256: hash(pixels.data),
    width: pixels.width,
    height: pixels.height,
  }
}

export async function blurred(pixels, sigma) {
  const output = await transformed(
    image(pixels).blur({ sigma, minAmplitude: 0.01, precision: "float" }),
  )
  assert.notEqual(
    hash(output.data),
    hash(pixels.data),
    "Blur must change the measured pixels",
  )
  return output
}

export async function runBenchmark({ extended = false } = {}) {
  // Public reproducible synthetic input; never use this demonstration key in production.
  const key = new Uint8Array(
    createHash("sha256").update("public-watermark-demonstration-v1").digest(),
  )
  const markIds = Array.from({ length: 8 }, (_, i) =>
    hash("public-copy-" + i).slice(0, 32),
  )
  const candidates = await Promise.all(
    markIds.map(async (markId) => ({
      markId,
      pattern: await markPattern(key, markId),
    })),
  )
  const wrongKey = new Uint8Array(
    createHash("sha256").update("public-wrong-key-control-v1").digest(),
  )
  const wrongCandidates = await Promise.all(
    markIds.map(async (markId) => ({
      markId,
      pattern: await markPattern(wrongKey, markId),
    })),
  )
  const cases = []
  let browser
  for (const kind of ["white", "gray", "texture"]) {
    const original = fixture(kind),
      marked = clone(original)
    embedMark(marked, candidates[0].pattern)
    const png = await image(marked).png().toBuffer()
    const capture = await screenshot(png, marked.width, marked.height, {
      trustedSynthetic: true,
    })
    browser = capture.browser
    const variants = [
      ["screenshot-100-percent", await decode(capture.png)],
      ...(await Promise.all(
        [20, 50].flatMap((percent) =>
          [0, 1].map(async (offset) => {
            const ratio = Math.sqrt(1 - percent / 100),
              width = Math.floor(marked.width * ratio),
              height = Math.floor(marked.height * ratio)
            return [
              `crop-${percent}-percent-area-offset-${offset}`,
              await transformed(
                image(marked).extract({
                  left: offset ? marked.width - width : 0,
                  top: offset ? marked.height - height : 0,
                  width,
                  height,
                }),
              ),
            ]
          }),
        ),
      )),
      [
        "jpeg-q90",
        await decode(
          await image(marked)
            .jpeg({ quality: 90, chromaSubsampling: "4:2:0" })
            .toBuffer(),
        ),
      ],
      [
        "jpeg-q60",
        await decode(
          await image(marked)
            .jpeg({ quality: 60, chromaSubsampling: "4:2:0" })
            .toBuffer(),
        ),
      ],
      [
        "resize-1920-to-800",
        await transformed(
          image(marked).resize({ width: 800, kernel: sharp.kernel.lanczos3 }),
        ),
      ],
      [
        "rotation-2-degrees",
        await transformed(
          image(marked).rotate(2, {
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          }),
        ),
      ],
    ]
    if (extended) {
      for (const angle of [
        -5, -3, -1, -0.75, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 0.75, 1, 3, 5, 10,
        45, 90, 180,
      ])
        variants.push([
          `rotation-${angle}-degrees`,
          await transformed(
            image(marked).rotate(angle, { background: "white" }),
          ),
        ])
      for (const quality of [75, 40, 20, 10])
        variants.push([
          `jpeg-q${quality}`,
          await decode(await image(marked).jpeg({ quality }).toBuffer()),
        ])
      for (const quality of [80, 40, 20]) {
        variants.push([
          `webp-q${quality}`,
          await decode(await image(marked).webp({ quality }).toBuffer()),
        ])
        variants.push([
          `avif-q${quality}`,
          await decode(
            await image(marked).avif({ quality, effort: 2 }).toBuffer(),
          ),
        ])
      }
      for (const width of [1200, 480, 320])
        variants.push([
          `resize-1920-to-${width}`,
          await transformed(image(marked).resize({ width })),
        ])
      for (const percent of [20, 50, 75, 90]) {
        const ratio = Math.sqrt(1 - percent / 100),
          width = Math.floor(marked.width * ratio),
          height = Math.floor(marked.height * ratio)
        variants.push([
          `center-crop-${percent}-percent`,
          await transformed(
            image(marked).extract({
              left: Math.floor((marked.width - width) / 2),
              top: Math.floor((marked.height - height) / 2),
              width,
              height,
            }),
          ),
        ])
      }
      variants.push([
        "rotation-crop-resize",
        await transformed(
          image(marked)
            .rotate(2, { background: "white" })
            .extract({ left: 200, top: 200, width: 1200, height: 900 })
            .resize({ width: 800 }),
        ),
      ])
      for (const sigma of [0.5, 1, 2])
        variants.push([`blur-${sigma}`, await blurred(marked, sigma)])
      variants.push(
        ["sharpen", await transformed(image(marked).sharpen())],
        ["gamma-1.5", await transformed(image(marked).gamma(1.5))],
        ["grayscale", await transformed(image(marked).grayscale())],
        ["inversion", await transformed(image(marked).negate())],
        ...(await Promise.all(
          [100, 180, 240].map(async (threshold) => [
            `binarize-${threshold}`,
            await transformed(image(marked).threshold(threshold)),
          ]),
        )),
      )
      const other = clone(original)
      embedMark(other, candidates[1].pattern)
      const mixed = clone(marked),
        mosaic = clone(marked)
      for (let p = 0; p < mixed.data.length; p++) {
        mixed.data[p] = (marked.data[p] + other.data[p]) / 2
        if (Math.floor(p / 4) % marked.width > marked.width / 2)
          mosaic.data[p] = other.data[p]
      }
      variants.push(["two-copy-average", mixed], ["two-copy-mosaic", mosaic])
    }
    const contrast = clone(marked),
      whiten = clone(marked)
    for (let p = 0; p < contrast.data.length; p += 4)
      for (let c = 0; c < 3; c++) {
        contrast.data[p + c] = 128 + 1.3 * (contrast.data[p + c] - 128)
        // Erase both white and black pixel variations on a mostly monochrome page.
        whiten.data[p + c] =
          marked.data[p + c] > 240
            ? 255
            : marked.data[p + c] < 60
              ? 30
              : marked.data[p + c]
      }
    variants.push(
      ["contrast-plus-30-percent-clipped", contrast],
      ["background-whitening-and-dark-threshold", whiten],
      ["pixel-recreation-from-source", original],
    )
    for (const [transformation, pixels] of variants) {
      const result = measure(pixels, candidates, markIds[0])
      const mixed = transformation.startsWith("two-copy-")
      assert.ok(
        !result.matched ||
          result.matched === markIds[0] ||
          (mixed && result.matched === markIds[1]),
        "Detector attributed an uninvolved copy",
      )
      cases.push({
        fixture: kind,
        transformation,
        ...result,
        ...(mixed
          ? {
              contributorMarkIds: [markIds[0], markIds[1]],
              expectedDecision: "ambiguous_multiple_sources",
              safeDecision: result.matched === null,
            }
          : {}),
      })
      console.log(
        `${kind} ${transformation}: ${result.detected ? "detected" : "not detected"}`,
      )
    }
    for (const [name, pixels, list] of [
      ["unmarked", original, candidates],
      ["wrong-key", marked, wrongCandidates],
    ]) {
      const result = measure(pixels, list, null)
      assert.equal(result.matched, null, `False match for ${kind}/${name}`)
      cases.push({
        fixture: kind,
        transformation: name,
        ...result,
        detected: false,
        negativeControl: true,
      })
    }
  }
  return {
    format: "privcloud-public-watermark-benchmark-v1",
    generatedAt: new Date().toISOString(),
    algorithmSha256: hash(
      await readFile(new URL("watermark.ts", import.meta.url)),
    ),
    tools: { node: process.version, sharp: sharp.versions, browser },
    threshold: MARK_DETECTION_THRESHOLD,
    candidateCount: 8,
    fixtures: ["white", "gray", "texture"],
    cropDefinition: "20/50 percent of image area removed; two corner offsets",
    cases,
    measuredSeparately: [
      {
        transformation: "new-whole-page-carrier-real-photo",
        report: "multiscale-results.json",
        scope: "One development photo without a visible code, synthetic successes and failures, and 100 coarse-channel negative controls. Not calibration of the combined detector.",
      },
      {
        transformation: "authenticated-visible-marker-real-photo",
        report: "visible-mark-results.json",
        scope: "Seven synthetic controls and one private development photo. A marker does not authenticate surrounding pixels.",
      },
      {
        transformation: "real-smartphone-photo",
        report: "photo-results.json",
        scope: "Two laboratory photographs and a separate preproduction failure. Not part of this synthetic matrix.",
      },
      {
        transformation: "screenshot-ocr-recreation",
        report: "ocr-results.json",
        scope: "Three Chrome screenshots reconstructed from real local Tesseract output. Pixel-source recreation remains a separate negative control.",
      },
    ],
    unmeasured: [
      { transformation: "real-printed-document-photo", reason: "No physical print/photo capture was measured." },
    ],
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runBenchmark({
    extended: process.argv.includes("--extended"),
  })
  // A report is a plain .json name in the current directory, never a path elsewhere.
  const name = path.basename(process.argv[2] || "results.json")
  assert.ok(
    name === (process.argv[2] || "results.json") && name.endsWith(".json"),
    "Name a .json report in the current directory",
  )
  await writeFile(
    path.join(process.cwd(), name),
    JSON.stringify(report, null, 2) + "\n",
  )
}
