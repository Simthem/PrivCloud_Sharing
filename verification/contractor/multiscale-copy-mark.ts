import {
  detectMark,
  estimateDocumentSkew,
  deskewMarkImage,
  MARK_TILE,
  type MarkAnalysis,
  type MarkCandidate,
  type Pixels,
} from "./watermark.ts"

export const ROBUST_COPY_ALGORITHM = "privcloud:forensic-multiscale:v2"
const PERIOD_MULTIPLIER = 4
const AMPLITUDE = 10

function checkPixels(pixels: Pixels) {
  if (
    !Number.isSafeInteger(pixels.width) ||
    !Number.isSafeInteger(pixels.height) ||
    pixels.width < 1 ||
    pixels.height < 1 ||
    pixels.width * pixels.height > 16_000_000 ||
    !(pixels.data instanceof Uint8ClampedArray) ||
    pixels.data.length !== pixels.width * pixels.height * 4
  )
    throw new Error("Invalid robust marker input")
}

/** Additional coarse carrier across every page pixel, independent of side bands. */
export function embedRobustCopyMark(pixels: Pixels, pattern: Float32Array) {
  checkPixels(pixels)
  if (
    !(pattern instanceof Float32Array) ||
    pattern.length !== MARK_TILE * MARK_TILE ||
    !pattern.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)
  )
    throw new Error("Invalid robust marker pattern")
  const at = (x: number, y: number) =>
    pattern[
      ((y + MARK_TILE) % MARK_TILE) * MARK_TILE + ((x + MARK_TILE) % MARK_TILE)
    ]
  for (let y = 0; y < pixels.height; y++)
    for (let x = 0; x < pixels.width; x++) {
      const sx = (x + 0.5) / PERIOD_MULTIPLIER - 0.5,
        sy = (y + 0.5) / PERIOD_MULTIPLIER - 0.5
      const x0 = Math.floor(sx) % MARK_TILE,
        y0 = Math.floor(sy) % MARK_TILE
      const fx = sx - Math.floor(sx),
        fy = sy - Math.floor(sy)
      const delta =
        AMPLITUDE *
        ((1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
          fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1)))
      const offset = (y * pixels.width + x) * 4
      for (let c = 0; c < 3; c++)
        pixels.data[offset + c] = Math.round(
          Math.max(
            AMPLITUDE,
            Math.min(255 - AMPLITUDE, pixels.data[offset + c]),
          ) + delta,
        )
    }
}

/** Candidate-independent preparation, including neutral spectral padding. */
function prepareRobustCopyMark(pixels: Pixels, divisor: number) {
  const sourceWidth =
    divisor === 1 ? Math.min(1024, pixels.width) : pixels.width
  const sourceHeight =
    divisor === 1 ? Math.min(1024, pixels.height) : pixels.height
  const sourceLeft = Math.floor((pixels.width - sourceWidth) / 2)
  const sourceTop = Math.floor((pixels.height - sourceHeight) / 2)
  const width = Math.floor(sourceWidth / divisor)
  const height = Math.floor(sourceHeight / divisor)
  if (Math.min(width, height) < 64) return null
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        let value = 0
        for (let dy = 0; dy < divisor; dy++)
          for (let dx = 0; dx < divisor; dx++)
            value +=
              pixels.data[
                ((sourceTop + y * divisor + dy) * pixels.width +
                  sourceLeft +
                  x * divisor +
                  dx) *
                  4 +
                  c
              ]
        data[(y * width + x) * 4 + c] =
          128 + 0.3 * (value / (divisor * divisor) - 128)
      }
  // A small power-of-two spectral crop can exclude the actual coarse period
  // and its half simultaneously. Neutral padding retains every observed pixel
  // without inventing a signal or changing the embedded carrier. Tiny inputs
  // are enlarged by a fixed factor so their period stays in the searched range.
  if (Math.min(width, height) >= 512) return { width, height, data }
  const factor = Math.min(width, height) < 128 ? 2 : 1
  const imageWidth = width * factor
  const imageHeight = height * factor
  const paddedSide = Math.max(
    512,
    Math.min(
      1024,
      2 ** Math.ceil(Math.log2(Math.max(imageWidth, imageHeight))),
    ),
  )
  const paddedWidth = Math.max(paddedSide, imageWidth)
  const paddedHeight = Math.max(paddedSide, imageHeight)
  if (paddedWidth * paddedHeight > 16_000_000) return null
  const padded = new Uint8ClampedArray(paddedWidth * paddedHeight * 4).fill(128)
  for (let index = 3; index < padded.length; index += 4) padded[index] = 255
  const left = Math.floor((paddedWidth - imageWidth) / 2)
  const top = Math.floor((paddedHeight - imageHeight) / 2)
  for (let y = 0; y < imageHeight; y++)
    for (let x = 0; x < imageWidth; x++) {
      const sx = Math.max(0, (x + 0.5) / factor - 0.5)
      const sy = Math.max(0, (y + 0.5) / factor - 0.5)
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(width - 1, x0 + 1)
      const y1 = Math.min(height - 1, y0 + 1)
      const fx = sx - x0
      const fy = sy - y0
      for (let channel = 0; channel < 3; channel++) {
        const at = (xx: number, yy: number) =>
          data[(yy * width + xx) * 4 + channel]
        padded[((top + y) * paddedWidth + left + x) * 4 + channel] =
          (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x1, y0)) +
          fy * ((1 - fx) * at(x0, y1) + fx * at(x1, y1))
      }
    }
  return { width: paddedWidth, height: paddedHeight, data: padded }
}

/** Preserve text contrast and suppress screen moire before estimating geometry. */
function contentSkew(pixels: Pixels) {
  const angles = [1200, 800].map((maximumSide) => {
    const divisor = Math.max(
      2,
      Math.ceil(Math.max(pixels.width, pixels.height) / maximumSide),
    )
    const width = Math.floor(pixels.width / divisor)
    const height = Math.floor(pixels.height / divisor)
    if (Math.min(width, height) < 64) return null
    const data = new Uint8ClampedArray(width * height * 4).fill(255)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0
        for (let dy = 0; dy < divisor; dy++)
          for (let dx = 0; dx < divisor; dx++) {
            const offset =
              ((y * divisor + dy) * pixels.width + x * divisor + dx) * 4
            sum +=
              (pixels.data[offset] +
                pixels.data[offset + 1] +
                pixels.data[offset + 2]) /
              3
          }
        const offset = (y * width + x) * 4
        data[offset] =
          data[offset + 1] =
          data[offset + 2] =
            sum / (divisor * divisor)
      }
    return estimateDocumentSkew({ width, height, data })
  })
  const [first, second] = angles
  if (first === null || second === null) return null
  const distance = Math.abs(first - second)
  return Math.min(distance, 90 - distance) <= 0.5 ? first : null
}

/** Fixed observed-pixel views cover reduced images and enlarged screen photos. */
export function detectRobustCopyMark(
  pixels: Pixels,
  candidates: MarkCandidate[],
) {
  checkPixels(pixels)
  if (candidates.length > 1000) throw new Error("Candidate budget exceeded")
  if (candidates.length === 0) return null
  const minimumSide = Math.min(pixels.width, pixels.height)
  const divisors =
    minimumSide >= 2048 ? [4, 8] : minimumSide >= 512 ? [4, 2, 1] : [4, 1]
  const analyses: MarkAnalysis[] = []
  const skew = contentSkew(pixels)
  for (const divisor of divisors) {
    const prepared = prepareRobustCopyMark(pixels, divisor)
    if (prepared) {
      analyses.push(detectMark(prepared, candidates))
      if (skew !== null && Math.abs(skew) >= 0.05)
        analyses.push(detectMark(deskewMarkImage(prepared, skew), candidates))
    }
  }
  return analyses.length ? combineCopyAnalyses(analyses) : null
}

/** Keep every plausible source across independently inspected carriers. */
export function combineCopyAnalyses(analyses: MarkAnalysis[]): MarkAnalysis {
  if (analyses.length === 0) throw new Error("Missing copy analysis")
  const strongest = analyses.reduce((best, value) =>
    value.topScore > best.topScore ? value : best,
  )
  const plausible = new Map<string, MarkAnalysis["compatible"][number]>()
  for (const analysis of analyses)
    for (const candidate of analysis.compatible)
      if ((plausible.get(candidate.markId)?.score ?? 0) < candidate.score)
        plausible.set(candidate.markId, candidate)
  const compatible = [...plausible.values()].sort((a, b) => b.score - a.score)
  if (compatible.length > 1)
    return {
      ...strongest,
      best: null,
      status: "ambiguous_multiple_sources",
      compatible,
      runnerUpScore: compatible[1].score,
    }
  return { ...strongest, compatible }
}
