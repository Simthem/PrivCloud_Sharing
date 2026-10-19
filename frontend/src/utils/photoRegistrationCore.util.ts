import type { Pixels } from "./forensicMark.util"

type Disposable = { delete: () => void }
type Mat = Disposable & {
  rows: number
  cols: number
  data: Uint8Array
  data64F: Float64Array
  empty: () => boolean
}
type Point = {
  x: number
  y: number
}
type Match = {
  queryIdx: number
  trainIdx: number
  distance: number
}
type Vector<T> = Disposable & {
  size: () => number
  get: (_index: number) => T
}
export type RegistrationCv = {
  Mat: new () => Mat
  ORB: new (..._options: number[]) => Disposable & {
    detectAndCompute: (
      _image: Mat,
      _mask: Mat,
      _keys: Vector<{ pt: Point }>,
      _descriptors: Mat,
    ) => void
  }
  BFMatcher: new (
    _norm: number,
    _crossCheck: boolean,
  ) => Disposable & {
    knnMatch: (
      _a: Mat,
      _b: Mat,
      _matches: Vector<Vector<Match>>,
      _k: number,
    ) => void
  }
  KeyPointVector: new () => Vector<{ pt: Point }>
  DMatchVectorVector: new () => Vector<Vector<Match>>
  Size: new (_width: number, _height: number) => unknown
  Scalar: new (..._values: number[]) => unknown
  matFromArray: (
    _rows: number,
    _cols: number,
    _type: number,
    _data: ArrayLike<number>,
  ) => Mat
  resize: (
    _source: Mat,
    _target: Mat,
    _size: unknown,
    _fx: number,
    _fy: number,
    _interpolation: number,
  ) => void
  cvtColor: (_source: Mat, _target: Mat, _conversion: number) => void
  findHomography: (
    _source: Mat,
    _target: Mat,
    _method: number,
    _threshold: number,
    _mask: Mat,
    _iterations: number,
    _confidence: number,
  ) => Mat
  warpPerspective: (
    _source: Mat,
    _target: Mat,
    _matrix: Mat,
    _size: unknown,
    _flags: number,
    _border: number,
    _fill: unknown,
  ) => void
  GaussianBlur: (
    _source: Mat,
    _target: Mat,
    _size: unknown,
    _sigmaX: number,
    _sigmaY: number,
    _border: number,
  ) => void
  CV_8UC4: number
  CV_32FC2: number
  CV_64F: number
  COLOR_RGBA2GRAY: number
  INTER_AREA: number
  INTER_LINEAR: number
  WARP_INVERSE_MAP: number
  BORDER_CONSTANT: number
  BORDER_REPLICATE: number
  NORM_HAMMING: number
  RANSAC: number
}
const MAX_PIXELS = 16_000_000
const FEATURE_SIDE = 1600

export function checkRegistrationPixels(value: Pixels, limit = MAX_PIXELS) {
  if (
    !value ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width * value.height > limit ||
    !(value.data instanceof Uint8ClampedArray) ||
    value.data.length !== value.width * value.height * 4
  )
    throw new Error("Invalid registration pixels")
}

/** Content-only geometry. Neither copy identifiers nor patterns enter this module. */
export function createPhotoRegistration(cv: RegistrationCv, photo: Pixels) {
  checkRegistrationPixels(photo)
  const retained: Disposable[] = []
  const keep = <T extends Disposable>(value: T) => {
    retained.push(value)
    return value
  }
  const detector = keep(new cv.ORB(10000, 1.2, 12, 20, 0, 2, 0, 31, 10))
  const matcher = keep(new cv.BFMatcher(cv.NORM_HAMMING, false))
  const full = keep(
    cv.matFromArray(photo.height, photo.width, cv.CV_8UC4, photo.data),
  )
  photo.data.fill(0)
  const mask = keep(new cv.Mat())
  const keys = keep(new cv.KeyPointVector())
  const descriptors = keep(new cv.Mat())
  let closed = false

  function featureImage(image: Mat, scope: Disposable[]) {
    const rgba = new cv.Mat(),
      gray = new cv.Mat()
    scope.push(rgba, gray)
    const scale = Math.min(1, FEATURE_SIDE / Math.max(image.cols, image.rows))
    cv.resize(
      image,
      rgba,
      new cv.Size(
        Math.round(image.cols * scale),
        Math.round(image.rows * scale),
      ),
      0,
      0,
      cv.INTER_AREA,
    )
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    return { gray, sx: rgba.cols / image.cols, sy: rgba.rows / image.rows }
  }
  const small = featureImage(full, retained)
  detector.detectAndCompute(small.gray, mask, keys, descriptors)

  const close = () => {
    if (closed) return
    closed = true
    full.data.fill(0)
    for (const value of retained.reverse()) value.delete()
  }

  const register = (reference: Pixels) => {
    if (closed) throw new Error("Registration closed")
    checkRegistrationPixels(reference, 4_000_000)
    const transient: Disposable[] = []
    const take = <T extends Disposable>(value: T) => {
      transient.push(value)
      return value
    }
    try {
      const original = take(
        cv.matFromArray(
          reference.height,
          reference.width,
          cv.CV_8UC4,
          reference.data,
        ),
      )
      const ref = featureImage(original, transient)
      const refKeys = take(new cv.KeyPointVector()),
        refDescriptors = take(new cv.Mat())
      detector.detectAndCompute(ref.gray, mask, refKeys, refDescriptors)
      if (descriptors.empty() || refDescriptors.empty()) return null
      const pairs = take(new cv.DMatchVectorVector())
      matcher.knnMatch(refDescriptors, descriptors, pairs, 2)
      const unique = new Map<number, Match>()
      for (let index = 0; index < pairs.size(); index++) {
        const pair = pairs.get(index)
        try {
          if (pair.size() !== 2) continue
          const first = pair.get(0),
            second = pair.get(1)
          if (first.distance >= 0.7 * second.distance) continue
          const previous = unique.get(first.trainIdx)
          if (!previous || first.distance < previous.distance)
            unique.set(first.trainIdx, first)
        } finally {
          pair.delete()
        }
      }
      const matches = [...unique.values()].sort(
        (a, b) => a.queryIdx - b.queryIdx,
      )
      if (matches.length < 40) return null
      const fitting = matches.filter((_, index) => index % 4 !== 0)
      const heldOut = matches.filter((_, index) => index % 4 === 0)
      const a = fitting.flatMap((match) => {
        const p = refKeys.get(match.queryIdx).pt
        return [p.x, p.y]
      })
      const b = fitting.flatMap((match) => {
        const p = keys.get(match.trainIdx).pt
        return [p.x, p.y]
      })
      const source = take(cv.matFromArray(fitting.length, 1, cv.CV_32FC2, a))
      const target = take(cv.matFromArray(fitting.length, 1, cv.CV_32FC2, b))
      const inlierMask = take(new cv.Mat())
      const h = take(
        cv.findHomography(
          source,
          target,
          cv.RANSAC,
          2,
          inlierMask,
          5000,
          0.999,
        ),
      )
      if (h.empty()) return null
      const inliers = [...inlierMask.data].filter(Boolean).length
      if (inliers < 20 || inliers / fitting.length < 0.25) return null
      const matrix = [...h.data64F]
      const project = (x: number, y: number, m = matrix) => {
        const denominator = m[6] * x + m[7] * y + m[8]
        return {
          x: (m[0] * x + m[1] * y + m[2]) / denominator,
          y: (m[3] * x + m[4] * y + m[5]) / denominator,
        }
      }
      const validationInliers = heldOut.filter((match) => {
        const p = refKeys.get(match.queryIdx).pt,
          q = keys.get(match.trainIdx).pt
        const predicted = project(p.x, p.y)
        return Math.hypot(predicted.x - q.x, predicted.y - q.y) <= 3
      }).length
      if (validationInliers < 6 || validationInliers / heldOut.length < 0.25)
        return null
      const points = fitting
        .filter((_, index) => inlierMask.data[index])
        .map((match) => refKeys.get(match.queryIdx).pt)
      const extent = (axis: "x" | "y") =>
        Math.max(...points.map((p) => p[axis])) -
        Math.min(...points.map((p) => p[axis]))
      if (
        extent("x") < ref.gray.cols * 0.25 ||
        extent("y") < ref.gray.rows * 0.25
      )
        return null
      for (let index = 0; index < 9; index++)
        matrix[index] *=
          (index < 3 ? 1 / small.sx : index < 6 ? 1 / small.sy : 1) *
          (index % 3 === 0 ? ref.sx : index % 3 === 1 ? ref.sy : 1)
      if (matrix.some((value) => !Number.isFinite(value))) return null
      const corners = [
        [0, 0],
        [reference.width, 0],
        [reference.width, reference.height],
        [0, reference.height],
      ].map(([x, y]) => project(x, y, matrix))
      let area = 0
      const turns = corners.map((p, index) => {
        const next = corners[(index + 1) % 4],
          after = corners[(index + 2) % 4]
        area += p.x * next.y - next.x * p.y
        return (
          (next.x - p.x) * (after.y - next.y) -
          (next.y - p.y) * (after.x - next.x)
        )
      })
      if (
        !corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ||
        !turns.every((value) => value > 0) ||
        Math.abs(area / 2) < photo.width * photo.height * 0.1 ||
        Math.abs(area / 2) > photo.width * photo.height * 4
      )
        return null
      const transform = take(cv.matFromArray(3, 3, cv.CV_64F, matrix))
      const warped = take(new cv.Mat())
      const center = project(reference.width / 2, reference.height / 2, matrix)
      const right = project(
        reference.width / 2 + 1,
        reference.height / 2,
        matrix,
      )
      const below = project(
        reference.width / 2,
        reference.height / 2 + 1,
        matrix,
      )
      const localScale = Math.sqrt(
        Math.abs(
          (right.x - center.x) * (below.y - center.y) -
            (right.y - center.y) * (below.x - center.x),
        ),
      )
      // Perspective warping alone does not antialias a reduced photograph.
      // Derive the low-pass solely from geometry, never from candidate scores.
      let samplingSource = full
      if (localScale > 1.25) {
        const filtered = take(new cv.Mat())
        const sigma = Math.min(
          2.5,
          0.5 * Math.sqrt(localScale * localScale - 1),
        )
        cv.GaussianBlur(
          full,
          filtered,
          new cv.Size(0, 0),
          sigma,
          sigma,
          cv.BORDER_REPLICATE,
        )
        samplingSource = filtered
      }
      // Resample only the capture. Never copy reference or expected-pattern pixels.
      cv.warpPerspective(
        samplingSource,
        warped,
        transform,
        new cv.Size(reference.width, reference.height),
        cv.INTER_LINEAR | cv.WARP_INVERSE_MAP,
        cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255),
      )
      return {
        pixels: {
          width: reference.width,
          height: reference.height,
          data: new Uint8ClampedArray(warped.data),
        },
        geometry: {
          matches: matches.length,
          inliers,
          validationInliers,
          validationMatches: heldOut.length,
        },
      }
    } finally {
      for (const value of transient.reverse()) value.delete()
    }
  }
  return { register, close }
}
