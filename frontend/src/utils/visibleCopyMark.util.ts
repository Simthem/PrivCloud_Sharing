import qrcode from "qrcode-generator"
import jsQR from "jsqr"
import type { MarkCandidate, Pixels } from "./forensicMark.util"

export type CopyMarkCandidate = MarkCandidate & {
  visibleToken?: string
  robust?: boolean
}
export const COPY_TOKEN = /^PC1:[a-f0-9]{32}:[a-f0-9]{32}$/

/** Public per-copy marker. It contains no document, account or team key. */
export async function visibleCopyToken(key: Uint8Array, markId: string) {
  if (key.length !== 32 || !/^[a-f0-9]{32}$/.test(markId))
    throw new Error("Invalid copy marker input")
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      imported,
      new TextEncoder().encode(`privcloud:visible-copy:v1:${markId}`),
    ),
  )
  const tag = Array.from(signature.subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  return `PC1:${markId}:${tag}`
}

export function copyMarkerGrid(token: string) {
  if (!COPY_TOKEN.test(token)) throw new Error("Invalid copy marker")
  const code = qrcode(0, "H")
  code.addData(token, "Byte")
  code.make()
  const size = code.getModuleCount()
  return { size, dark: (x: number, y: number) => code.isDark(y, x) }
}

/** Append a repeated readable band without obscuring original document pixels. */
export function appendCopyMarker(canvas: HTMLCanvasElement, token: string) {
  const code = copyMarkerGrid(token)
  const modulePixels = 3
  const side = (code.size + 8) * modulePixels
  const band = side + 16
  const output = document.createElement("canvas")
  output.width = canvas.width + band
  output.height = Math.max(canvas.height, side + 16)
  if (output.width * output.height > 16_000_000)
    throw new Error("Marked page exceeds pixel budget")
  const context = output.getContext("2d")
  if (!context) throw new Error("Canvas unavailable")
  context.fillStyle = "white"
  context.fillRect(0, 0, output.width, output.height)
  context.drawImage(canvas, 0, 0)
  context.fillStyle = "#303030"
  const last = output.height - side - 8
  const positions = new Set([8])
  const step = Math.max(400, side + 100)
  for (let y = 8 + step; y + side + 100 <= last; y += step) positions.add(y)
  if (last >= 8 + side + 100) positions.add(last)
  for (const top of positions)
    for (let y = 0; y < code.size; y++)
      for (let x = 0; x < code.size; x++)
        if (code.dark(x, y))
          context.fillRect(
            canvas.width + 8 + (x + 4) * modulePixels,
            top + (y + 4) * modulePixels,
            modulePixels,
            modulePixels,
          )
  return { canvas: output, context }
}

/** Bounded local decoder. Decoded strings are compared only, never opened. */
export function detectVisibleCopyMarks(
  pixels: Pixels,
  candidates: CopyMarkCandidate[],
) {
  if (
    !Number.isSafeInteger(pixels.width) ||
    !Number.isSafeInteger(pixels.height) ||
    pixels.width < 1 ||
    pixels.height < 1 ||
    pixels.width * pixels.height > 16_000_000 ||
    pixels.data.length !== pixels.width * pixels.height * 4 ||
    candidates.length > 1000
  )
    throw new Error("Invalid or oversized visible marker input")
  const known = new Map(
    candidates
      .filter(
        (candidate) =>
          candidate.visibleToken && COPY_TOKEN.test(candidate.visibleToken),
      )
      .map((candidate) => [candidate.visibleToken!, candidate.markId]),
  )
  if (known.size === 0) return []
  const found = new Set<string>()
  for (const [maximumSide, smooth] of [
    [1600, false],
    [2000, true],
  ] as const) {
    const scale = Math.min(
      1,
      maximumSide / Math.max(pixels.width, pixels.height),
    )
    const width = Math.max(1, Math.floor(pixels.width * scale))
    const height = Math.max(1, Math.floor(pixels.height * scale))
    let data = new Uint8ClampedArray(width * height * 4).fill(255)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = Math.max(
          0,
          Math.min(pixels.width - 1, (x + 0.5) / scale - 0.5),
        )
        const sy = Math.max(
          0,
          Math.min(pixels.height - 1, (y + 0.5) / scale - 0.5),
        )
        const x0 = Math.floor(sx),
          y0 = Math.floor(sy)
        const x1 = Math.min(pixels.width - 1, x0 + 1),
          y1 = Math.min(pixels.height - 1, y0 + 1)
        const fx = sx - x0,
          fy = sy - y0
        for (let c = 0; c < 3; c++) {
          const at = (xx: number, yy: number) =>
            pixels.data[(yy * pixels.width + xx) * 4 + c]
          data[(y * width + x) * 4 + c] =
            (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x1, y0)) +
            fy * ((1 - fx) * at(x0, y1) + fx * at(x1, y1))
        }
      }
    if (smooth) {
      // Fixed separable binomial filter suppresses screen sampling aliases.
      // It never uses a candidate key, ID or decoder score to choose geometry.
      const horizontal = new Uint8ClampedArray(data.length).fill(255)
      const filtered = new Uint8ClampedArray(data.length).fill(255)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          for (let c = 0; c < 3; c++) {
            const at = (xx: number) =>
              data[(y * width + Math.max(0, Math.min(width - 1, xx))) * 4 + c]
            horizontal[(y * width + x) * 4 + c] =
              (at(x - 1) + 2 * at(x) + at(x + 1)) / 4
          }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          for (let c = 0; c < 3; c++) {
            const at = (yy: number) =>
              horizontal[
                (Math.max(0, Math.min(height - 1, yy)) * width + x) * 4 + c
              ]
            filtered[(y * width + x) * 4 + c] =
              (at(y - 1) + 2 * at(y) + at(y + 1)) / 4
          }
      data = filtered
    }
    const scan = (view: Uint8ClampedArray, w: number, h: number) => {
      const code = jsQR(view, w, h, { inversionAttempts: "dontInvert" })
      const id = code ? known.get(code.data) : undefined
      if (id) found.add(id)
    }
    scan(data, width, height)
    // Repeated finder patterns can confuse a whole-page locator. Overlapping
    // tiles isolate individual codes and inspect competing sources.
    const tileWidth = Math.min(width, 400),
      tileHeight = Math.min(height, 400)
    const columns = new Set<number>(),
      rows = new Set<number>()
    for (let x = 0; x < width; x += 200)
      columns.add(Math.min(x, width - tileWidth))
    for (let y = 0; y < height; y += 200)
      rows.add(Math.min(y, height - tileHeight))
    for (const top of rows)
      for (const left of columns) {
        const view = new Uint8ClampedArray(tileWidth * tileHeight * 4)
        for (let y = 0; y < tileHeight; y++)
          view.set(
            data.subarray(
              ((top + y) * width + left) * 4,
              ((top + y) * width + left + tileWidth) * 4,
            ),
            y * tileWidth * 4,
          )
        scan(view, tileWidth, tileHeight)
        if (found.size === known.size) return [...found]
      }
  }
  return [...found]
}
