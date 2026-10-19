import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { fixture } from "./benchmark.mjs"
import { embedMark, markPattern } from "./watermark.ts"
import {
  embedRobustCopyMark,
  detectRobustCopyMark,
  ROBUST_COPY_ALGORITHM,
} from "./multiscale-copy-mark.ts"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const clone = (pixels) => ({
  ...pixels,
  data: new Uint8ClampedArray(pixels.data),
})
const candidatesFor = async (seed) =>
  Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const markId = hash(`multiscale-evaluation-copy:${seed}:${index}`).slice(
        0,
        32,
      )
      return {
        markId,
        pattern: await markPattern(
          new Uint8Array(
            Buffer.from(hash(`multiscale-evaluation-key:${seed}`), "hex"),
          ),
          markId,
        ),
      }
    }),
  )
const measure = (pixels, candidates) => {
  const start = performance.now()
  const result = detectRobustCopyMark(pixels, candidates)
  return {
    status: result?.status ?? "inconclusive",
    matched: result?.best?.markId ?? null,
    compatibleCount: result?.compatible.length ?? 0,
    topScore: result?.topScore ?? 0,
    runnerUpScore: result?.runnerUpScore ?? 0,
    elapsedMs: Math.round(performance.now() - start),
  }
}
export async function runMultiscaleBenchmark() {
  const candidates = await candidatesFor("positive")
  const decode = async (bytes) => {
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    }
  }
  const cases = []
  for (const kind of ["white", "gray", "texture"]) {
    const original = fixture(kind, 1191, 1684)
    const marked = clone(original)
    embedRobustCopyMark(marked, candidates[0].pattern)
    embedMark(marked, candidates[0].pattern)
    const { data, info } = await sharp(Buffer.from(marked.data), {
      raw: { width: marked.width, height: marked.height, channels: 4 },
    })
      .extract({ left: 195, top: 300, width: 800, height: 1000 })
      .jpeg({ quality: 20 })
      .toBuffer()
      .then((bytes) =>
        sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      )
    const crop = {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    }
    const reconstructed = clone(original)
    const supplementary = []
    const image = () =>
      sharp(Buffer.from(marked.data), {
        raw: { width: marked.width, height: marked.height, channels: 4 },
      })
    for (const width of [1000, 800, 640, 480, 320]) {
      const reduced = await decode(
        await image().resize({ width }).png().toBuffer(),
      )
      supplementary.push([
        `resize-to-${width}-no-visible-code`,
        reduced,
        candidates,
        candidates[0].markId,
      ])
      supplementary.push([
        `resize-to-${width}-expected-copy-absent`,
        reduced,
        candidates.slice(1),
        null,
      ])
    }
    const zoom = await decode(
      await image()
        .resize({ width: Math.round(marked.width * 3.4) })
        .extract({ left: 480, top: 600, width: 3072, height: 4080 })
        .png()
        .toBuffer(),
    )
    supplementary.push([
      "zoom-3.4-central-capture-no-visible-code",
      zoom,
      candidates,
      candidates[0].markId,
    ])
    supplementary.push([
      "zoom-3.4-expected-copy-absent",
      zoom,
      candidates.slice(1),
      null,
    ])
    const second = clone(original)
    embedRobustCopyMark(second, candidates[1].pattern)
    embedMark(second, candidates[1].pattern)
    for (const name of ["two-copy-average", "two-copy-mosaic"]) {
      const mixture = clone(marked)
      for (let y = 0; y < mixture.height; y++)
        for (let x = 0; x < mixture.width; x++)
          for (let channel = 0; channel < 3; channel++) {
            const offset = (y * mixture.width + x) * 4 + channel
            if (name === "two-copy-average")
              mixture.data[offset] =
                (marked.data[offset] + second.data[offset]) / 2
            else if ((Math.floor(x / 80) + Math.floor(y / 80)) % 2)
              mixture.data[offset] = second.data[offset]
          }
      supplementary.push([name, mixture, candidates, null])
    }
    for (const [name, pixels, available, expected] of [
      ["intact-no-visible-code", marked, candidates, candidates[0].markId],
      [
        "central-crop-jpeg-q20-no-visible-code",
        crop,
        candidates,
        candidates[0].markId,
      ],
      ["expected-copy-absent", crop, candidates.slice(1), null],
      ["unmarked-source-recreation", reconstructed, candidates, null],
      ...supplementary,
    ]) {
      const result = measure(pixels, available)
      assert.ok(
        result.matched === null || result.matched === expected,
        `${kind}/${name}: incorrect attribution ${JSON.stringify(result)}`,
      )
      cases.push({
        kind,
        name,
        width: pixels.width,
        height: pixels.height,
        ...result,
        expected,
        correct: result.matched === expected,
        safeDecision: result.matched === null || result.matched === expected,
      })
    }
  }
  const negatives = []
  for (let trial = 0; trial < 300; trial++) {
    const seed = hash(`multiscale-reduction-evaluation-negative:v2.1:${trial}`)
    const available = await candidatesFor(seed)
    const [width, height] = [
      [320, 452],
      [800, 1000],
      [2048, 2560],
    ][trial % 3]
    const pixels = {
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }
    let randomState = Number.parseInt(seed.slice(0, 8), 16)
    for (let y = 0; y < pixels.height; y++)
      for (let x = 0; x < pixels.width; x++) {
        randomState ^= randomState << 13
        randomState ^= randomState >>> 17
        randomState ^= randomState << 5
        const value =
          150 +
          25 * Math.sin(x / 31) +
          20 * Math.cos(y / 37) +
          ((randomState >>> 0) / 4294967296) * 24
        const offset = (y * pixels.width + x) * 4
        pixels.data[offset] =
          pixels.data[offset + 1] =
          pixels.data[offset + 2] =
            value
      }
    const control = ["unmarked", "other-team", "absent-copy"][
      Math.floor(trial / 3) % 3
    ]
    if (control !== "unmarked") {
      const pattern =
        control === "other-team"
          ? (await candidatesFor(`foreign:${seed}`))[0].pattern
          : await markPattern(
              new Uint8Array(
                Buffer.from(hash(`multiscale-evaluation-key:${seed}`), "hex"),
              ),
              hash(`absent:${seed}`).slice(0, 32),
            )
      embedRobustCopyMark(pixels, pattern)
      embedMark(pixels, pattern)
    }
    const result = measure(pixels, available)
    assert.equal(
      result.matched,
      null,
      `negative ${trial}: ${JSON.stringify(result)}`,
    )
    negatives.push({ trial, control, width, height, ...result })
    if (trial % 25 === 0 && process.argv[1] === fileURLToPath(import.meta.url))
      console.log(`Multiscale negatives ${trial}/300`)
  }
  return {
    format: "privcloud-forensic-multiscale-evaluation-v2",
    generatedAt: new Date().toISOString(),
    algorithm: ROBUST_COPY_ALGORITHM,
    algorithmSha256: hash(
      await readFile(new URL("multiscale-copy-mark.ts", import.meta.url)),
    ),
    watermarkSha256: hash(
      await readFile(new URL("watermark.ts", import.meta.url)),
    ),
    harnessSha256: hash(
      await readFile(new URL("multiscale-benchmark.mjs", import.meta.url)),
    ),
    fixtureSha256: hash(
      await readFile(new URL("benchmark.mjs", import.meta.url)),
    ),
    tools: { node: process.version, sharp: sharp.versions },
    candidateCount: 8,
    threshold: 8,
    cases,
    negatives,
    falseMatches: negatives.filter((value) => value.matched !== null).length,
    limits: [
      "Coarse-channel exploratory evaluation, not calibration of the combined legacy/coarse/QR decision.",
      "A single separately reported development smartphone photo is not a held-out validation corpus.",
      "The added carrier changes page RGB values and can be faintly visible. It cannot repair historical copies.",
      "Cropping away the QR band does not necessarily remove this whole-page carrier. Tiny crops, perspective, filtering or scale changes may still defeat it.",
      "OCR reconstruction and reconstruction from the unmarked source can erase every pixel carrier. No recipient attribution is claimed after such erasure.",
      "The earlier 1000-trial v1 false-match bound does not apply to this additional search channel.",
    ],
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, "Usage: node multiscale-benchmark.mjs")
  const report = await runMultiscaleBenchmark()
  const directory = await mkdtemp(
    path.join(process.cwd(), "multiscale-report-"),
  )
  await writeFile(
    path.join(directory, "multiscale-results.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  )
  console.log(`Multiscale report saved in ${directory}`)
}
