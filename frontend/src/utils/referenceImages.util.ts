import type { Pixels } from "./forensicMark.util"
import { EXTERNAL_PAGE_MAX_WIDTH } from "./externalPreviewLayout.util"
import { isPdf, SuspectFileError } from "./suspectImages.util"
import { hashPreviewSource } from "./sha256Stream.util"

export async function referenceDigest(file: File, signal: AbortSignal) {
  if (file.size <= 0 || file.size > 64 * 1024 * 1024)
    throw new SuspectFileError("too_large")
  return hashPreviewSource(
    {
      size: file.size,
      read: async (start, end) =>
        new Uint8Array(await file.slice(start, end).arrayBuffer()),
    },
    signal,
  )
}

/** The same native PDF raster scale as issuance, without either watermark. */
export async function* referenceImages(file: File, signal: AbortSignal) {
  if (!isPdf(file)) throw new SuspectFileError("unsupported")
  const pdfjs = await import("pdfjs-dist")
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    maxImageSize: 4_000_000,
    stopAtErrors: true,
  })
  const abort = () => {
    void task.destroy()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    const documentPdf = await task.promise
    if (documentPdf.numPages > 50) throw new SuspectFileError("too_large")
    for (let pageNumber = 1; pageNumber <= documentPdf.numPages; pageNumber++) {
      signal.throwIfAborted()
      const page = await documentPdf.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(
        2,
        EXTERNAL_PAGE_MAX_WIDTH / base.width,
        Math.sqrt(4_000_000 / (base.width * base.height)),
      )
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement("canvas")
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      if (canvas.width * canvas.height > 4_010_000)
        throw new SuspectFileError("too_large")
      const context = canvas.getContext("2d", { willReadFrequently: true })
      if (!context) throw new SuspectFileError("unsupported")
      try {
        context.fillStyle = "#ffffff"
        context.fillRect(0, 0, canvas.width, canvas.height)
        const render = page.render({ canvasContext: context, viewport })
        const cancelRender = () => render.cancel()
        signal.addEventListener("abort", cancelRender, { once: true })
        try {
          await render.promise
        } finally {
          signal.removeEventListener("abort", cancelRender)
        }
        const pixels: Pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        )
        yield { pixels, page: pageNumber, total: documentPdf.numPages }
      } finally {
        canvas.width = canvas.height = 0
        page.cleanup()
      }
    }
  } finally {
    signal.removeEventListener("abort", abort)
    await task.destroy()
  }
}
