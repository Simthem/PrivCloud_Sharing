import type { Pixels } from "./forensicMark.util"

// Images to look for invisible marks in, from a file someone found: the image
// itself, or for a PDF every embedded image at its own resolution (a capture
// pasted into a document keeps its pixels) and every rendered page.

const MAX_PIXELS = 16_000_000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_PDF_PAGES = 50
const MIN_EMBEDDED_SIDE = 128
// Rendered pages: wide enough to keep the mark of a page-wide capture.
const RENDER_WIDTH = 2000
const RENDER_MAX_PIXELS = 8_000_000

export type SuspectImage = {
  pixels: Pixels
  // 1-based page of a PDF, absent for an image file.
  page?: number
  source: "image" | "embedded" | "page"
}

export class SuspectFileError extends Error {
  constructor(public code: "too_large" | "unsupported") {
    super(code)
  }
}

export function isPdf(file: File) {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  )
}

function canvasPixels(
  draw: (_context: CanvasRenderingContext2D) => void,
  width: number,
  height: number,
): Pixels {
  if (width * height > MAX_PIXELS) throw new SuspectFileError("too_large")
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new SuspectFileError("unsupported")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  draw(context)
  const image = context.getImageData(0, 0, width, height)
  canvas.width = canvas.height = 0
  return image
}

async function imageFilePixels(file: File): Promise<Pixels> {
  const bitmap = await createImageBitmap(file)
  try {
    return canvasPixels(
      (context) => context.drawImage(bitmap, 0, 0),
      bitmap.width,
      bitmap.height,
    )
  } finally {
    bitmap.close()
  }
}

type PdfImageObject = {
  width?: number
  height?: number
  kind?: number
  data?: Uint8Array | Uint8ClampedArray
  bitmap?: ImageBitmap
}

/** An image object decoded by pdf.js, as RGBA pixels. */
function embeddedPixels(image: PdfImageObject): Pixels | null {
  const width = image.width ?? image.bitmap?.width ?? 0
  const height = image.height ?? image.bitmap?.height ?? 0
  if (Math.min(width, height) < MIN_EMBEDDED_SIDE) return null
  if (width * height > MAX_PIXELS) return null
  if (image.bitmap) {
    const bitmap = image.bitmap
    return canvasPixels(
      (context) => context.drawImage(bitmap, 0, 0),
      width,
      height,
    )
  }
  const source = image.data
  if (!source) return null
  const data = new Uint8ClampedArray(width * height * 4)
  // pdf.js ImageKind: 2 = RGB 24 bits, 3 = RGBA 32 bits. Bilevel images
  // (kind 1) cannot carry a mark.
  if (image.kind === 2 && source.length >= width * height * 3) {
    for (let p = 0, s = 0; p < data.length; p += 4, s += 3) {
      data[p] = source[s]
      data[p + 1] = source[s + 1]
      data[p + 2] = source[s + 2]
      data[p + 3] = 255
    }
  } else if (image.kind === 3 && source.length >= data.length) {
    data.set(source.subarray(0, data.length))
  } else {
    return null
  }
  return { data, width, height }
}

/** Every image worth analysing in a suspect file, one at a time. */
export async function* suspectImages(
  file: File,
  signal?: AbortSignal,
): AsyncGenerator<SuspectImage> {
  signal?.throwIfAborted()
  if (file.size <= 0 || file.size > MAX_FILE_BYTES)
    throw new SuspectFileError("too_large")
  if (!isPdf(file)) {
    yield { pixels: await imageFilePixels(file), source: "image" }
    return
  }
  const pdfjs = await import("pdfjs-dist")
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    maxImageSize: MAX_PIXELS,
    stopAtErrors: true,
  })
  const abort = () => {
    void task.destroy()
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const pdf = await task.promise
    if (pdf.numPages > MAX_PDF_PAGES) throw new SuspectFileError("too_large")
    const pages = pdf.numPages
    for (let number = 1; number <= pages; number++) {
      signal?.throwIfAborted()
      const page = await pdf.getPage(number)
      const operators = await page.getOperatorList()
      // Rendering resolves PDF.js image dependencies. getOperatorList alone
      // can finish before image objects arrive, silently skipping native pixels.
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(
        RENDER_WIDTH / base.width,
        Math.sqrt(RENDER_MAX_PIXELS / (base.width * base.height)),
      )
      const viewport = page.getViewport({ scale })
      const width = Math.ceil(viewport.width)
      const height = Math.ceil(viewport.height)
      const canvas = renderCanvas(width, height)
      try {
        await page.render({ canvasContext: canvas.context, viewport }).promise
        const seen = new Set<string>()
        for (let i = 0; i < operators.fnArray.length; i++) {
          if (operators.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue
          const name = operators.argsArray[i]?.[0]
          if (typeof name !== "string" || seen.has(name)) continue
          seen.add(name)
          const objects = name.startsWith("g_") ? page.commonObjs : page.objs
          if (!objects.has(name)) continue
          const pixels = embeddedPixels(objects.get(name) as PdfImageObject)
          if (pixels) yield { pixels, page: number, source: "embedded" }
        }
        // Also inspect the displayed page for marks over vector content.
        const pixels = canvas.context.getImageData(0, 0, width, height)
        yield { pixels, page: number, source: "page" }
      } finally {
        canvas.release()
        page.cleanup()
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    await task.destroy()
  }
}

function renderCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new SuspectFileError("unsupported")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  return {
    context,
    release: () => {
      canvas.width = canvas.height = 0
    },
  }
}
