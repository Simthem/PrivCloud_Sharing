import {
  MARK_TILE,
  MARK_AMPLITUDE,
  MARK_MIN_SCORE_GAP,
  isMarkId,
  type Pixels,
  type MarkCandidate,
  type MarkAnalysis,
  type MarkDetection,
} from "./watermark.ts"

const MARK_CHIP = 4
export const FRAGMENT_COPY_THRESHOLD = 10
export const FRAGMENT_SCALE_HYPOTHESES = 181
export const FRAGMENT_CANDIDATE_BUDGET = 128

export function canAnalyseFragment(pixels: Pixels, candidateCount: number) {
  return (
    candidateCount > 0 &&
    candidateCount <= FRAGMENT_CANDIDATE_BUDGET &&
    Math.min(pixels.width, pixels.height) >= 32 &&
    Math.max(pixels.width, pixels.height) <= 1024 &&
    pixels.width * pixels.height <= 262144
  )
}

// Kept separate so historical v1 algorithm snapshots and measurements stay exact.
// The FFT and peak normalization follow the v1 correlation convention.
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const savedRe = re[i],
        savedIm = im[i]
      re[i] = re[j]
      im[i] = im[j]
      re[j] = savedRe
      im[j] = savedIm
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/** 2-D FFT of a size x size row-major grid, in place. */
function fft2d(
  re: Float64Array,
  im: Float64Array,
  size: number,
  inverse: boolean,
) {
  const rowRe = new Float64Array(size)
  const rowIm = new Float64Array(size)
  for (let y = 0; y < size; y++) {
    const offset = y * size
    rowRe.set(re.subarray(offset, offset + size))
    rowIm.set(im.subarray(offset, offset + size))
    fft(rowRe, rowIm, inverse)
    re.set(rowRe, offset)
    im.set(rowIm, offset)
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      rowRe[y] = re[y * size + x]
      rowIm[y] = im[y * size + x]
    }
    fft(rowRe, rowIm, inverse)
    for (let y = 0; y < size; y++) {
      re[y * size + x] = rowRe[y]
      im[y * size + x] = rowIm[y]
    }
  }
}

/**
 * Luminance minus its local mean. Pixels that differ from their surroundings
 * by more than the mark ever does (text, lines, edges) say nothing about it:
 * they are dropped rather than clipped.
 */
function highPass(pixels: Pixels, radius: number): Float32Array {
  const { data, width, height } = pixels
  const luma = new Float64Array(width * height)
  for (let i = 0, p = 0; p < luma.length; i += 4, p++) {
    luma[p] = (data[i] + data[i + 1] + data[i + 2]) / 3
  }
  const stride = width + 1
  const integral = new Float64Array(stride * (height + 1))
  for (let y = 0; y < height; y++) {
    let sum = 0
    for (let x = 0; x < width; x++) {
      sum += luma[y * width + x]
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum
    }
  }
  const limit = 2 * MARK_AMPLITUDE
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height, y + radius + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width, x + radius + 1)
      const mean =
        (integral[y1 * stride + x1] -
          integral[y0 * stride + x1] -
          integral[y1 * stride + x0] +
          integral[y0 * stride + x0]) /
        ((y1 - y0) * (x1 - x0))
      const value = luma[y * width + x] - mean
      out[y * width + x] = value > limit || value < -limit ? 0 : value
    }
  }
  return out
}

type Region = {
  left: number
  top: number
  width: number
  height: number
}

function centralRegion(width: number, height: number, size: number): Region {
  const w = Math.min(width, size)
  const h = Math.min(height, size)
  return {
    left: Math.floor((width - w) / 2),
    top: Math.floor((height - h) / 2),
    width: w,
    height: h,
  }
}

/**
 * A region of the filtered image folded on the period MARK_TILE * scale,
 * back to MARK_TILE x MARK_TILE cells, zero mean. Absolute coordinates keep
 * the same phase whatever the region.
 */
function fold(
  filtered: Float32Array,
  imageWidth: number,
  scale: number,
  region: Region,
): Float64Array {
  const sum = new Float64Array(MARK_TILE * MARK_TILE)
  const count = new Uint32Array(MARK_TILE * MARK_TILE)
  const columns = new Int32Array(region.width)
  for (let x = 0; x < region.width; x++) {
    columns[x] = Math.floor((region.left + x) / scale) % MARK_TILE
  }
  for (let y = 0; y < region.height; y++) {
    const row = (Math.floor((region.top + y) / scale) % MARK_TILE) * MARK_TILE
    const offset = (region.top + y) * imageWidth + region.left
    for (let x = 0; x < region.width; x++) {
      const value = filtered[offset + x]
      if (value === 0) continue
      sum[row + columns[x]] += value
      count[row + columns[x]]++
    }
  }
  let mean = 0
  let filled = 0
  for (let i = 0; i < sum.length; i++) {
    if (count[i]) {
      sum[i] /= count[i]
      mean += sum[i]
      filled++
    }
  }
  mean /= filled || 1
  for (let i = 0; i < sum.length; i++) sum[i] = count[i] ? sum[i] - mean : 0
  return sum
}

type PreparedCandidate = {
  markId: string
  re: Float64Array
  im: Float64Array
}

function prepareCandidate(candidate: MarkCandidate): PreparedCandidate {
  const re = new Float64Array(MARK_TILE * MARK_TILE)
  const im = new Float64Array(MARK_TILE * MARK_TILE)
  let mean = 0
  for (const value of candidate.pattern) mean += value
  mean /= candidate.pattern.length
  for (let i = 0; i < re.length; i++) re[i] = candidate.pattern[i] - mean
  fft2d(re, im, MARK_TILE, false)
  return { markId: candidate.markId, re, im }
}

/**
 * Peak of the cyclic cross-correlation, in standard deviations of the rest of
 * the correlation surface (the peak and its neighbourhood excluded).
 */
function correlationScore(
  foldedRe: Float64Array,
  foldedIm: Float64Array,
  candidate: PreparedCandidate,
  scratchRe: Float64Array,
  scratchIm: Float64Array,
) {
  const n = MARK_TILE * MARK_TILE
  const re = scratchRe
  const im = scratchIm
  for (let i = 0; i < n; i++) {
    // folded * conj(candidate)
    re[i] = foldedRe[i] * candidate.re[i] + foldedIm[i] * candidate.im[i]
    im[i] = foldedIm[i] * candidate.re[i] - foldedRe[i] * candidate.im[i]
  }
  fft2d(re, im, MARK_TILE, true)
  let peak = 0
  for (let i = 1; i < n; i++) if (re[i] > re[peak]) peak = i
  const px = peak % MARK_TILE
  const py = Math.floor(peak / MARK_TILE)
  const exclusion = 2 * MARK_CHIP
  let sum = 0
  let squares = 0
  let count = 0
  for (let y = 0; y < MARK_TILE; y++) {
    const dy = Math.min(Math.abs(y - py), MARK_TILE - Math.abs(y - py))
    for (let x = 0; x < MARK_TILE; x++) {
      const dx = Math.min(Math.abs(x - px), MARK_TILE - Math.abs(x - px))
      if (dx <= exclusion && dy <= exclusion) continue
      const value = re[y * MARK_TILE + x]
      sum += value
      squares += value * value
      count++
    }
  }
  const mean = sum / count
  const deviation = Math.sqrt(Math.max(squares / count - mean * mean, 1e-30))
  return (re[peak] - mean) / deviation
}

/** Exhaustive fixed scales for small fragments whose spectrum cannot resolve a tile. */
export function detectFragmentCopyMark(
  pixels: Pixels,
  candidates: MarkCandidate[],
):
  | (MarkAnalysis & {
      minimumScore: number
      fragmentHypotheses: number
    })
  | null {
  if (
    !pixels ||
    !Number.isSafeInteger(pixels.width) ||
    !Number.isSafeInteger(pixels.height) ||
    pixels.width < 1 ||
    pixels.height < 1 ||
    pixels.width * pixels.height > 16_000_000 ||
    !(
      pixels.data instanceof Uint8Array ||
      pixels.data instanceof Uint8ClampedArray
    ) ||
    pixels.data.length !== pixels.width * pixels.height * 4 ||
    !Array.isArray(candidates) ||
    candidates.length > 1000 ||
    new Set(candidates.map((value) => value?.markId)).size !==
      candidates.length ||
    candidates.some(
      (value) =>
        !value ||
        !isMarkId(value.markId) ||
        !(value.pattern instanceof Float32Array) ||
        value.pattern.length !== MARK_TILE * MARK_TILE ||
        !value.pattern.every(
          (number) => Number.isFinite(number) && Math.abs(number) <= 1,
        ),
    )
  )
    throw new Error("Invalid fragment analysis input")
  if (
    !candidates.length ||
    candidates.length > FRAGMENT_CANDIDATE_BUDGET ||
    Math.min(pixels.width, pixels.height) < 32 ||
    Math.max(pixels.width, pixels.height) > 1024 ||
    pixels.width * pixels.height > 262144
  )
    return null
  const filtered = highPass(pixels, 3)
  if (!filtered.some((value) => value !== 0)) return null
  const region = centralRegion(pixels.width, pixels.height, 1024)
  const views = Array.from(
    { length: FRAGMENT_SCALE_HYPOTHESES },
    (_, index) => {
      const scale = 0.35 + index * 0.005
      const re = fold(filtered, pixels.width, scale, region)
      const im = new Float64Array(re.length)
      fft2d(re, im, MARK_TILE, false)
      return { scale, re, im }
    },
  )
  const scratchRe = new Float64Array(MARK_TILE * MARK_TILE)
  const scratchIm = new Float64Array(scratchRe.length)
  const ranked: MarkDetection[] = []
  const trialCount =
    FRAGMENT_SCALE_HYPOTHESES * candidates.length * MARK_TILE * MARK_TILE
  for (let begin = 0; begin < candidates.length; begin += 32) {
    const prepared = candidates.slice(begin, begin + 32).map(prepareCandidate)
    for (const candidate of prepared) {
      let score = 0,
        scale = 1
      for (const view of views) {
        const current = correlationScore(
          view.re,
          view.im,
          candidate,
          scratchRe,
          scratchIm,
        )
        if (current > score) {
          score = current
          scale = view.scale
        }
      }
      ranked.push({
        markId: candidate.markId,
        score,
        scale,
        falseMatchLog10: Math.min(
          0,
          Math.log10(trialCount) +
            Math.log10(0.5) -
            (score * score) / (2 * Math.LN10),
        ),
      })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  // A stricter unique decision must not hide a plausible secondary source.
  const compatible = ranked.filter((value) => value.score >= 8)
  const unique =
    compatible.length === 1 &&
    ranked[0].score >= FRAGMENT_COPY_THRESHOLD &&
    ranked[0].score - (ranked[1]?.score ?? 0) >= MARK_MIN_SCORE_GAP
  return {
    best: unique ? ranked[0] : null,
    compatible,
    status:
      compatible.length > 1
        ? "ambiguous_multiple_sources"
        : unique
          ? "match"
          : "inconclusive",
    topScore: ranked[0]?.score ?? 0,
    runnerUpScore: ranked[1]?.score ?? 0,
    scales: [...new Set(ranked.map((value) => value.scale))].slice(0, 16),
    rotation: 0,
    minimumScore: FRAGMENT_COPY_THRESHOLD,
    fragmentHypotheses: FRAGMENT_SCALE_HYPOTHESES,
  }
}
