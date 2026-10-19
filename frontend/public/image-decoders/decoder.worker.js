// Decodes one still image the browser cannot display (HEIC/HEIF, TIFF, camera
// RAW). Served with its own CSP allowing WebAssembly (see next.config.js), so
// the document policy keeps refusing it. One worker per image: terminating it
// returns the decoder's memory, which WebAssembly never shrinks.
// Libraries and decoder-core.mjs are copied here by
// scripts/build-image-decoders.mjs.

const FORMATS = ["heif", "tiff", "raw"];
let used = false;

async function loadHeif() {
  importScripts("/image-decoders/libheif.js");
  const response = await fetch("/image-decoders/libheif.wasm");
  if (!response.ok) throw new Error("Decoder unavailable");
  return self.libheif({ wasmBinary: await response.arrayBuffer() });
}

async function loadTiff() {
  // UTIF's CMYK conversion reads window.UDOC, and a worker has no window.
  // Safe here only: this worker never loads libheif, whose glue would take
  // a window for a web page.
  self.window = self;
  importScripts(
    "/image-decoders/pako_inflate.min.js",
    "/image-decoders/UTIF.js",
  );
  return self.UTIF;
}

self.onmessage = async (event) => {
  if (
    !event.isTrusted ||
    event.origin !== "" ||
    event.source !== null ||
    event.ports.length
  )
    return;
  const message = event.data;
  if (
    used ||
    !message ||
    message.id !== 1 ||
    message.type !== "decode" ||
    !FORMATS.includes(message.format) ||
    !(message.bytes instanceof ArrayBuffer) ||
    !Number.isSafeInteger(message.maxSide) ||
    message.maxSide < 1 ||
    Object.keys(message).length !== 5
  )
    return;
  used = true;
  try {
    const { decodeStillImage } =
      await import("/image-decoders/decoder-core.mjs");
    const result = await decodeStillImage(
      message.format,
      new Uint8Array(message.bytes),
      { heif: loadHeif, tiff: loadTiff },
      message.maxSide,
    );
    const pixels = result.kind === "jpeg" ? result.bytes : result.data;
    self.postMessage({ id: message.id, type: "result", result }, [
      pixels.buffer,
    ]);
  } catch {
    self.postMessage({ id: message.id, type: "error" });
  }
};
