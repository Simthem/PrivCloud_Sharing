// Invisible forensic mark of the copies rendered for external contractors.
//
// Each copy carries its own pseudo-random pattern, derived from a secret team
// audit key and the mark id of the copy, added to every pixel with a few
// levels of amplitude. The pattern repeats every MARK_TILE pixels, so any
// fragment of a page still holds many periods of it. Detection runs in the
// browser of a team administrator: it finds the period (hence the scale) from
// the spectrum of the image, folds the image on that period and correlates the
// result with the pattern of every copy the team issued.
// The key is needed to reconstruct the exact pattern. Destructive transforms
// such as thresholding or pixel recreation can erase it without the key.
// The server never sees the audit key or the suspect image.

export const MARK_TILE = 128
const MARK_CHIPS = 32
const MARK_CHIP = MARK_TILE / MARK_CHIPS
export const MARK_AMPLITUDE = 3

// Correlation peak, in standard deviations, from which a pattern is compatible.
export const MARK_DETECTION_THRESHOLD = 8
export const MARK_MIN_SCORE_GAP = 2
export const MARK_ALGORITHM = "privcloud:forensic-mark:v1"
// A perfect copy scores about sqrt(MARK_CHIPS^2): the pattern has 1024 chips.
export const MARK_SCORE_CEILING = 32

// Scales accepted for a suspect image (screenshot reduced or enlarged).
const MIN_SCALE = 0.35
const MAX_SCALE = 2.5
// The scale is first estimated from the spectrum of a central crop, then
// refined by folding a larger area on candidate periods.
const SPECTRUM_SIZE = 1024
const COARSE_STEP = 0.001
const FINE_CROP = 1400
const FINE_SPAN = 0.006
const SPLIT_SCALE = 1.25
const SCALE_HYPOTHESES = 4
const DETECTION_CROP = 2048

export type Pixels = {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export type MarkCandidate = { markId: string; pattern: Float32Array }

export type MarkDetection = {
  markId: string
  score: number
  scale: number
  // log10 of a Gaussian noise-model estimate, adjusted for the search size.
  // This is not an empirically calibrated real-world false-attribution rate.
  falseMatchLog10: number
}

export type MarkAnalysis = {
  best: MarkDetection | null
  runnerUpScore: number
  scales: number[]
  status: "match" | "inconclusive" | "ambiguous_multiple_sources"
  compatible: MarkDetection[]
  rotation: number
  topScore: number
}

const encoder = new TextEncoder()

/** 128-bit identifier of one rendered copy, lowercase hex. */
export function newMarkId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function isMarkId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value)
}

/**
 * The MARK_TILE x MARK_TILE pattern of a copy: random +1/-1 chips of
 * MARK_CHIP pixels, one bit each of HMAC-SHA256(auditKey, markId, block),
 * smoothed by periodic bilinear interpolation so that resampling keeps it.
 */
export async function markPattern(
  auditKey: Uint8Array,
  markId: string,
): Promise<Float32Array> {
  if (auditKey.length !== 32 || !isMarkId(markId)) {
    throw new Error("Invalid forensic mark key or id")
  }
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    auditKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  // 256 chips per HMAC block, one block per counter value.
  const chips = new Float32Array(MARK_CHIPS * MARK_CHIPS)
  for (let block = 0; block < chips.length / 256; block++) {
    const bits = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        encoder.encode(`privcloud:forensic-mark:v1:${markId}:${block}`),
      ),
    )
    for (let i = 0; i < 256; i++) {
      chips[block * 256 + i] = (bits[i >> 3] >> (i & 7)) & 1 ? 1 : -1
    }
  }
  const pattern = new Float32Array(MARK_TILE * MARK_TILE)
  const at = (i: number, j: number) =>
    chips[
      ((j + MARK_CHIPS) % MARK_CHIPS) * MARK_CHIPS +
        ((i + MARK_CHIPS) % MARK_CHIPS)
    ]
  for (let y = 0; y < MARK_TILE; y++) {
    const ty = (y + 0.5) / MARK_CHIP - 0.5
    const j = Math.floor(ty)
    const fy = ty - j
    for (let x = 0; x < MARK_TILE; x++) {
      const tx = (x + 0.5) / MARK_CHIP - 0.5
      const i = Math.floor(tx)
      const fx = tx - i
      pattern[y * MARK_TILE + x] =
        (1 - fy) * ((1 - fx) * at(i, j) + fx * at(i + 1, j)) +
        fy * ((1 - fx) * at(i, j + 1) + fx * at(i + 1, j + 1))
    }
  }
  return pattern
}

/**
 * Adds the pattern to the RGB channels, in place. Values are first kept
 * MARK_AMPLITUDE away from black and white so that the paper, mostly white,
 * carries the whole pattern instead of half of it.
 */
export function embedMark(
  pixels: Pixels,
  pattern: Float32Array,
  amplitude = MARK_AMPLITUDE,
) {
  const { data, width, height } = pixels
  const high = 255 - amplitude
  for (let y = 0; y < height; y++) {
    const row = (y % MARK_TILE) * MARK_TILE
    for (let x = 0; x < width; x++) {
      const delta = amplitude * pattern[row + (x % MARK_TILE)]
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const value = data[i + c]
        const base = value > high ? high : value < amplitude ? amplitude : value
        data[i + c] = Math.round(base + delta)
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

/** In-place radix-2 complex FFT. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
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

type Region = { left: number; top: number; width: number; height: number }

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

function energy(folded: Float64Array) {
  let total = 0
  for (const value of folded) total += value * value
  return total
}

/**
 * Scales at which the image repeats like a mark tile. A pattern of period T
 * puts its energy on the frequency lattice (k/T, l/T), off the axes too,
 * while text lines and columns keep theirs on the axes. Each period is scored
 * on the whitened spectrum of a central crop, then refined by folding, since
 * the pattern only adds up at its exact period. No key is involved: this
 * works for every copy at once.
 */
function scaleHypotheses(pixels: Pixels, filtered: Float32Array): number[] {
  const { width, height } = pixels
  // Large scales put the lattice points too close to each other for the
  // whitening: they are searched on the image reduced by half.
  const reduced = halve(pixels)
  const peaks = [
    ...spectralPeaks(filtered, width, height, MIN_SCALE, SPLIT_SCALE),
    ...spectralPeaks(
      highPass(reduced, 3),
      reduced.width,
      reduced.height,
      SPLIT_SCALE / 2,
      MAX_SCALE / 2,
    ).map((peak) => ({ ...peak, scale: peak.scale * 2 })),
  ].sort((left, right) => right.score - left.score)
  const fine = centralRegion(width, height, FINE_CROP)
  // The smaller the image, the less precise the spectrum, and the less
  // precision folding needs.
  const span = Math.max(FINE_SPAN, 6 / Math.min(fine.width, fine.height))
  const step = span / 20
  // A lattice of period 2T shares half of its peaks with the true one: each
  // hypothesis brings its half and its double along.
  const candidates: number[] = []
  for (const peak of peaks.slice(0, SCALE_HYPOTHESES)) {
    for (const scale of [peak.scale, peak.scale / 2, peak.scale * 2]) {
      if (
        scale >= MIN_SCALE &&
        scale <= MAX_SCALE &&
        !candidates.some((other) => Math.abs(other / scale - 1) < 2 * span)
      ) {
        candidates.push(scale)
      }
    }
  }
  const refined: number[] = []
  for (const candidate of candidates) {
    let best = candidate
    let bestEnergy = -Infinity
    for (let d = -span; d <= span + 1e-9; d += step) {
      const scale = candidate * (1 + d)
      const value = energy(fold(filtered, width, scale, fine))
      if (value > bestEnergy) {
        bestEnergy = value
        best = scale
      }
    }
    refined.push(best)
  }
  return refined
}

/** Box-averaged to half size. */
function halve(pixels: Pixels): Pixels {
  const width = Math.floor(pixels.width / 2)
  const height = Math.floor(pixels.height / 2)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const at = (dx: number, dy: number) =>
          pixels.data[((2 * y + dy) * pixels.width + 2 * x + dx) * 4 + c]
        data[o + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4
      }
      data[o + 3] = 255
    }
  }
  return { data, width, height }
}

function spectralPeaks(
  filtered: Float32Array,
  width: number,
  height: number,
  minScale: number,
  maxScaleWanted: number,
): { scale: number; score: number }[] {
  const n = Math.min(
    SPECTRUM_SIZE,
    2 ** Math.floor(Math.log2(Math.min(width, height))),
  )
  const crop = centralRegion(width, height, n)
  const re = new Float64Array(n * n)
  const im = new Float64Array(n * n)
  // Hann window: the crop borders must not ring over the whole spectrum.
  for (let y = 0; y < crop.height; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / crop.height)
    for (let x = 0; x < crop.width; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / crop.width)
      re[y * n + x] = filtered[(crop.top + y) * width + crop.left + x] * wx * wy
    }
  }
  fft2d(re, im, n, false)
  const power = new Float64Array(n * n)
  for (let i = 0; i < power.length; i++) {
    power[i] = re[i] * re[i] + im[i] * im[i]
  }
  const whitened = whiten(power, n)
  const at = (fx: number, fy: number) => {
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const v = (x: number, y: number) =>
      whitened[(((y % n) + n) % n) * n + (((x % n) + n) % n)]
    return (
      Math.max(v(x0, y0), v(x0 + 1, y0), v(x0, y0 + 1), v(x0 + 1, y0 + 1)) *
      (0.75 + 0.25 * (1 - Math.abs(tx - 0.5) - Math.abs(ty - 0.5)))
    )
  }
  // A tile must fit at least twice in the crop to be measured at all.
  const maxScale = Math.min(
    maxScaleWanted,
    Math.min(crop.width, crop.height) / (2 * MARK_TILE),
  )
  const scales: number[] = []
  const scores: number[] = []
  for (let scale = minScale; scale <= maxScale; scale *= 1 + COARSE_STEP) {
    const step = n / (MARK_TILE * scale)
    let sum = 0
    let count = 0
    for (let k = 1; k <= MARK_CHIPS / 2 && k * step < n / 2; k++) {
      for (let l = 1; l <= MARK_CHIPS / 2 && l * step < n / 2; l++) {
        // (k, l) and (k, -l): the other two quadrants mirror them.
        sum += at(k * step, l * step) + at(k * step, n - l * step)
        count += 2
      }
    }
    scales.push(scale)
    scores.push(count ? sum / count : 0)
  }
  const peaks: { scale: number; score: number }[] = []
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] > scores[i - 1] && scores[i] >= scores[i + 1]) {
      peaks.push({ scale: scales[i], score: scores[i] })
    }
  }
  return peaks
}

/** Power divided by its local mean, so that every frequency band weighs alike. */
function whiten(power: Float64Array, n: number) {
  const radius = 4
  const stride = n + 1
  const integral = new Float64Array(stride * (n + 1))
  for (let y = 0; y < n; y++) {
    let sum = 0
    for (let x = 0; x < n; x++) {
      sum += power[y * n + x]
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum
    }
  }
  const out = new Float64Array(n * n)
  for (let y = 0; y < n; y++) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(n, y + radius + 1)
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(n, x + radius + 1)
      const mean =
        (integral[y1 * stride + x1] -
          integral[y0 * stride + x1] -
          integral[y1 * stride + x0] +
          integral[y0 * stride + x0]) /
        ((y1 - y0) * (x1 - x0))
      out[y * n + x] = mean > 0 ? power[y * n + x] / mean : 0
    }
  }
  return out
}

type PreparedCandidate = { markId: string; re: Float64Array; im: Float64Array }

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
) {
  const n = MARK_TILE * MARK_TILE
  const re = new Float64Array(n)
  const im = new Float64Array(n)
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

/** log10 of the Gaussian upper tail Q(z), accurate enough for large z. */
function log10GaussianTail(z: number) {
  if (z <= 0) return 0
  return (-(z * z) / 2 - Math.log(z * Math.sqrt(2 * Math.PI))) / Math.LN10
}

/**
 * Looks for the copies of `candidates` in a suspect image (screenshot, crop,
 * export of a page). Returns the best match, if any reaches the threshold.
 */
function detectAlignedMark(
  pixels: Pixels,
  candidates: MarkCandidate[],
): MarkAnalysis {
  const { width, height } = pixels
  if (width < 64 || height < 64 || candidates.length === 0) {
    return {
      best: null,
      runnerUpScore: 0,
      scales: [],
      status: "inconclusive",
      compatible: [],
      rotation: 0,
      topScore: 0,
    }
  }
  const searchFiltered = highPass(pixels, 3)
  const scales = scaleHypotheses(pixels, searchFiltered)
  // Pixel-native captures and narrow crops still carry a unit-scale pattern.
  // A small power-of-two FFT crop cannot always resolve that lattice; keep the
  // exact unit hypothesis instead of excluding it with the spectral crop size.
  if (!scales.some((scale) => Math.abs(scale - 1) < 0.0001)) scales.push(1)
  const prepared = candidates.map(prepareCandidate)
  const tests =
    MARK_TILE * MARK_TILE * prepared.length * Math.max(1, scales.length)
  const region = centralRegion(width, height, DETECTION_CROP)
  const best = new Map<string, MarkDetection>()
  for (const scale of scales) {
    // About one chip: wide enough to keep the pattern, narrow enough to
    // drop the paper texture and the antialiasing of the text.
    const radius = Math.max(2, Math.min(8, Math.round(MARK_CHIP * scale)))
    const filtered = radius === 3 ? searchFiltered : highPass(pixels, radius)
    const folded = fold(filtered, width, scale, region)
    const foldedIm = new Float64Array(folded.length)
    fft2d(folded, foldedIm, MARK_TILE, false)
    for (const candidate of prepared) {
      const score = correlationScore(folded, foldedIm, candidate)
      const previous = best.get(candidate.markId)
      if (!previous || score > previous.score) {
        best.set(candidate.markId, {
          markId: candidate.markId,
          score,
          scale,
          falseMatchLog10: Math.min(
            0,
            Math.log10(tests) + log10GaussianTail(score),
          ),
        })
      }
    }
  }
  const ranked = [...best.values()].sort(
    (left, right) => right.score - left.score,
  )
  const top = ranked[0]
  const compatible = ranked.filter(
    (candidate) => candidate.score >= MARK_DETECTION_THRESHOLD,
  )
  const unique =
    compatible.length === 1 &&
    top.score - (ranked[1]?.score ?? 0) >= MARK_MIN_SCORE_GAP
  return {
    best: unique ? top : null,
    runnerUpScore: ranked[1]?.score ?? 0,
    scales,
    status:
      compatible.length > 1
        ? "ambiguous_multiple_sources"
        : unique
          ? "match"
          : "inconclusive",
    compatible,
    rotation: 0,
    topScore: top?.score ?? 0,
  }
}

/** Document-line projection, independent of the secret patterns and scores. */
export function estimateDocumentSkew(pixels: Pixels): number | null {
  const { width, height, data } = pixels
  const points: number[] = []
  // A regular sampling grid itself creates projection peaks at 0/90 degrees.
  // Deterministic dispersed samples avoid that alias without using mark keys.
  let seed = 0x61c88647
  const sample = (size: number) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return 1 + ((seed >>> 0) % Math.max(1, size - 2))
  }
  for (let point = 0; point < 120_000; point++) {
    const x = sample(width),
      y = sample(height)
    const at = (dx: number, dy: number) => data[((y + dy) * width + x + dx) * 4]
    if (Math.abs(at(0, 1) - at(0, -1)) + Math.abs(at(1, 0) - at(-1, 0)) > 80) {
      points.push(x - width / 2, y - height / 2)
    }
  }
  if (points.length < 100) return null
  const offset = Math.ceil(Math.hypot(width, height))
  const histogram = new Uint32Array(2 * offset + 2)
  const score = (angle: number) => {
    histogram.fill(0)
    const radians = (angle * Math.PI) / 180
    const sine = Math.sin(radians),
      cosine = Math.cos(radians)
    for (let i = 0; i < points.length; i += 2) {
      histogram[
        Math.round(-sine * points[i] + cosine * points[i + 1]) + offset
      ]++
    }
    let total = 0
    for (const count of histogram) total += count * count
    return total
  }
  let angle = 0,
    peak = 0,
    total = 0
  for (let value = -45; value <= 45; value++) {
    const power = score(value)
    total += power
    if (power > peak) {
      peak = power
      angle = value
    }
  }
  if (peak < (total / 91) * 1.15) return null
  const coarse = angle
  for (let step = -40; step <= 40; step++) {
    const value = coarse + step / 40
    const power = score(value)
    if (power > peak) {
      peak = power
      angle = value
    }
  }
  return angle
}

/** Inverse map onto the same canvas, with neutral added borders. */
export function deskewMarkImage(pixels: Pixels, angle: number): Pixels {
  const { width, height } = pixels
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const sine = Math.sin((angle * Math.PI) / 180),
    cosine = Math.cos((angle * Math.PI) / 180)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = x - (width - 1) / 2,
        dy = y - (height - 1) / 2
      const sx = cosine * dx - sine * dy + (width - 1) / 2
      const sy = sine * dx + cosine * dy + (height - 1) / 2
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue
      const fx = sx - x0,
        fy = sy - y0
      for (let c = 0; c < 3; c++) {
        const at = (xx: number, yy: number) =>
          pixels.data[(yy * width + xx) * 4 + c]
        data[(y * width + x) * 4 + c] =
          (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
          fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1))
      }
    }
  return { data, width, height }
}

/** Bounded geometric recovery; never alter the v1 insertion pattern. */
export function detectMark(
  pixels: Pixels,
  candidates: MarkCandidate[],
): MarkAnalysis {
  if (
    !Number.isSafeInteger(pixels.width) ||
    !Number.isSafeInteger(pixels.height) ||
    pixels.width < 1 ||
    pixels.height < 1 ||
    pixels.width * pixels.height > 16_000_000 ||
    pixels.data.length !== pixels.width * pixels.height * 4 ||
    candidates.length > 1000 ||
    new Set(candidates.map((c) => c.markId)).size !== candidates.length ||
    candidates.some(
      (c) =>
        !isMarkId(c.markId) ||
        c.pattern.length !== MARK_TILE * MARK_TILE ||
        !c.pattern.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    )
  ) {
    throw new Error("Invalid or oversized forensic input")
  }
  const aligned = detectAlignedMark(pixels, candidates)
  // Several plausible patterns must never be resolved by choosing a rotation.
  // Weak direct matches still need geometric recovery, including tiny rotations.
  if (
    aligned.status === "ambiguous_multiple_sources" ||
    (aligned.best && aligned.topScore >= 2 * MARK_DETECTION_THRESHOLD) ||
    candidates.length === 0
  )
    return aligned
  const skew = estimateDocumentSkew(pixels)
  if (skew === null) return aligned
  const found: MarkAnalysis[] = [aligned]
  for (const turn of [0, 90, 180, 270]) {
    const angle = skew + turn
    if (Math.abs(angle) < 0.01) continue
    const result = detectAlignedMark(deskewMarkImage(pixels, angle), candidates)
    found.push({ ...result, rotation: angle })
  }
  const plausible = new Map<string, MarkDetection>()
  for (const result of found)
    for (const candidate of result.compatible) {
      if ((plausible.get(candidate.markId)?.score ?? 0) < candidate.score)
        plausible.set(candidate.markId, candidate)
    }
  const compatible = [...plausible.values()].sort((a, b) => b.score - a.score)
  const strongest = found.sort((a, b) => b.topScore - a.topScore)[0]
  return compatible.length > 1
    ? {
        ...strongest,
        best: null,
        compatible,
        runnerUpScore: compatible[1].score,
        status: "ambiguous_multiple_sources",
      }
    : strongest
}
