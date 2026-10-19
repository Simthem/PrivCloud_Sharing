// Decodes the HEVC pictures of one video the browser cannot play itself
// (Chrome or Firefox on Linux, for instance). A module worker served with its
// own CSP allowing WebAssembly (see next.config.js), so the document policy
// keeps refusing it. One worker per video: terminating it returns the decoder
// memory, which WebAssembly never shrinks.
// libde265.mjs, libde265.wasm and hevc-core.mjs are copied here by
// scripts/build-video-decoders.mjs.
import initialize from "./libde265.mjs";
import { createHevcDecoder } from "./hevc-core.mjs";

const MAX_SAMPLES_PER_MESSAGE = 64;
const MAX_PARAMETER_SETS = 64;

let decoder = null;
let configuring = false;
let failed = false;
let queue = Promise.resolve();

const hasKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const isEpoch = (value) => Number.isSafeInteger(value) && value >= 0;

const isSample = (sample) =>
  hasKeys(sample, ["timestamp", "data"]) &&
  Number.isFinite(sample.timestamp) &&
  sample.data instanceof ArrayBuffer &&
  sample.data.byteLength > 0;

function isValid(message) {
  if (!message || typeof message.type !== "string") return false;
  switch (message.type) {
    case "configure":
      return (
        hasKeys(message, ["type", "parameterSets", "nalLengthSize"]) &&
        [1, 2, 4].includes(message.nalLengthSize) &&
        Array.isArray(message.parameterSets) &&
        message.parameterSets.length > 0 &&
        message.parameterSets.length <= MAX_PARAMETER_SETS &&
        message.parameterSets.every((unit) => unit instanceof ArrayBuffer)
      );
    case "decode":
      return (
        hasKeys(message, ["type", "epoch", "samples"]) &&
        isEpoch(message.epoch) &&
        Array.isArray(message.samples) &&
        message.samples.length > 0 &&
        message.samples.length <= MAX_SAMPLES_PER_MESSAGE &&
        message.samples.every(isSample)
      );
    case "flush":
    case "reset":
      return hasKeys(message, ["type", "epoch"]) && isEpoch(message.epoch);
    default:
      return false;
  }
}

function post(epoch, frames) {
  for (const frame of frames)
    self.postMessage({ type: "frame", epoch, frame }, [frame.data.buffer]);
}

async function handle(message) {
  if (message.type === "configure") {
    if (decoder || configuring) throw new Error("Already configured");
    configuring = true;
    const library = await initialize();
    decoder = createHevcDecoder(
      library,
      message.parameterSets.map((unit) => new Uint8Array(unit)),
      message.nalLengthSize,
    );
    self.postMessage({ type: "configured" });
    return;
  }
  if (!decoder) throw new Error("Not configured");
  if (message.type === "reset") {
    decoder.reset();
  } else if (message.type === "decode") {
    post(
      message.epoch,
      decoder.decode(
        message.samples.map(({ timestamp, data }) => ({
          timestamp,
          data: new Uint8Array(data),
        })),
      ),
    );
    self.postMessage({
      type: "decoded",
      epoch: message.epoch,
      count: message.samples.length,
    });
  } else {
    post(message.epoch, decoder.flush());
    self.postMessage({ type: "flushed", epoch: message.epoch });
  }
}

self.onmessage = (event) => {
  if (
    !event.isTrusted ||
    event.origin !== "" ||
    event.source !== null ||
    event.ports.length ||
    failed ||
    !isValid(event.data)
  )
    return;
  const message = event.data;
  queue = queue
    .then(() => (failed ? undefined : handle(message)))
    .catch(() => {
      // A decoder that failed once is left in an unknown state.
      failed = true;
      self.postMessage({ type: "error" });
    });
};
