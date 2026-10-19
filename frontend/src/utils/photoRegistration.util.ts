import type { Pixels } from "./forensicMark.util"
import { checkRegistrationPixels } from "./photoRegistrationCore.util"

export type RegisteredPhoto = {
  pixels: Pixels
  geometry: {
    matches: number
    inliers: number
    validationInliers: number
    validationMatches: number
  }
}

/** No key, candidate, reference file or photograph is sent to a remote service. */
export async function createPhotoRegistrar(photo: Pixels, signal: AbortSignal) {
  signal.throwIfAborted()
  checkRegistrationPixels(photo)
  const worker = new Worker("/forensic/registration.worker.js")
  let closed = false,
    id = 0
  let pending: {
    id: number
    width: number
    height: number
    type: "init" | "register"
    resolve: (_value: RegisteredPhoto | null) => void
    reject: (_error: Error) => void
  } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    if (closed) return
    closed = true
    worker.onmessage = null
    worker.terminate()
    clearTimeout(timer)
    signal.removeEventListener("abort", close)
    pending?.reject(new DOMException("Registration stopped", "AbortError"))
    pending = null
  }
  signal.addEventListener("abort", close, { once: true })
  worker.addEventListener("error", close)
  worker.onmessage = (event: MessageEvent) => {
    if (
      event.origin !== "" ||
      !event.isTrusted ||
      event.source !== null ||
      event.currentTarget !== worker ||
      event.ports.length ||
      closed ||
      !pending
    )
      return
    const reply = event.data
    if (!reply || reply.id !== pending.id) return
    if (reply.type === "error") {
      close()
      return
    }
    if (
      pending.type === "init" ? reply.type !== "ready" : reply.type !== "result"
    )
      return
    const value = reply.result ?? null
    if (value !== null) {
      try {
        checkRegistrationPixels(value.pixels, 4_000_000)
        const g = value.geometry
        if (
          value.pixels.width !== pending.width ||
          value.pixels.height !== pending.height ||
          !g ||
          ![
            g.matches,
            g.inliers,
            g.validationInliers,
            g.validationMatches,
          ].every(
            (number) =>
              Number.isSafeInteger(number) && number >= 0 && number <= 10000,
          ) ||
          g.inliers < 20 ||
          g.validationInliers < 6 ||
          g.inliers > g.matches - g.validationMatches ||
          g.validationMatches > g.matches ||
          g.validationInliers > g.validationMatches
        )
          throw new Error("Invalid registration reply")
      } catch {
        close()
        return
      }
    }
    clearTimeout(timer)
    const current = pending
    pending = null
    current.resolve(value)
  }
  const request = (type: "init" | "register", pixels: Pixels) =>
    new Promise<RegisteredPhoto | null>((resolve, reject) => {
      if (closed || pending) {
        reject(new Error("Registration unavailable"))
        return
      }
      checkRegistrationPixels(pixels, type === "init" ? 16_000_000 : 4_000_000)
      pending = {
        id: ++id,
        type,
        width: pixels.width,
        height: pixels.height,
        resolve,
        reject,
      }
      timer = setTimeout(close, 60_000)
      worker.postMessage({ id, type, pixels }, [
        pixels.data.buffer as ArrayBuffer,
      ])
    })
  try {
    await request("init", photo)
    return {
      register: (reference: Pixels) => request("register", reference),
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
