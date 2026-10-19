let registration
let busy = false
self.onmessage = async (event) => {
  if (
    !event.isTrusted ||
    event.origin !== "" ||
    event.source !== null ||
    event.ports.length
  )
    return
  const message = event.data
  if (
    !message ||
    !Number.isSafeInteger(message.id) ||
    message.id < 1 ||
    !["init", "register"].includes(message.type) ||
    Object.keys(message).length !== 3 ||
    busy
  )
    return
  busy = true
  try {
    if (message.type === "init") {
      if (registration) throw new Error("Already initialized")
      importScripts("/forensic/opencv-csp.js")
      const cv = await self.cv
      const { createPhotoRegistration } =
        await import("/forensic/registration-core.mjs")
      registration = createPhotoRegistration(cv, message.pixels)
      self.postMessage({ id: message.id, type: "ready" })
    } else {
      if (!registration) throw new Error("Not initialized")
      const result = registration.register(message.pixels)
      message.pixels.data.fill(0)
      self.postMessage(
        { id: message.id, type: "result", result },
        result ? [result.pixels.data.buffer] : [],
      )
    }
  } catch {
    self.postMessage({ id: message.id, type: "error" })
    registration?.close()
    registration = undefined
  } finally {
    busy = false
  }
}
