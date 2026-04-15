/**
 * crypto-worker.js -- Web Worker for E2E chunk encryption
 *
 * Runs AES-256-GCM encryption in a dedicated V8 isolate so that the
 * ~36 MB of intermediate ArrayBuffers per chunk (plaintext + ciphertext)
 * never accumulate on the main renderer heap.  Buffers are transferred
 * (zero-copy) back to the main thread.
 *
 * Protocol:
 *   main -> worker: { type: 'init',         rawKey: ArrayBuffer }
 *   worker -> main: { type: 'ready' }
 *   main -> worker: { type: 'setFile',      file: Blob }
 *   worker -> main: { type: 'fileSet' }
 *   main -> worker: { type: 'encryptChunk', from: number, to: number }
 *   worker -> main: { type: 'encrypted',    encBuf: ArrayBuffer } [transferred]
 *   worker -> main: { type: 'error',        message: string }
 *
 * Output format per chunk: [IV 12 bytes][ciphertext + GCM auth tag 16 bytes]
 * -- identical to encryptFile() in crypto.util.ts.
 */

var IV_LENGTH = 12;
var cryptoKey = null;
var currentFile = null;

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "init") {
    crypto.subtle
      .importKey("raw", msg.rawKey, { name: "AES-GCM", length: 256 }, false, [
        "encrypt",
      ])
      .then(function (key) {
        cryptoKey = key;
        self.postMessage({ type: "ready" });
      })
      .catch(function (err) {
        self.postMessage({
          type: "error",
          message: err.message || "Key import failed",
        });
      });
    return;
  }

  if (msg.type === "setFile") {
    currentFile = msg.file;
    self.postMessage({ type: "fileSet" });
    return;
  }

  if (msg.type === "encryptChunk") {
    var blob = currentFile.slice(msg.from, msg.to);
    blob
      .arrayBuffer()
      .then(function (plainBuf) {
        var iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        return crypto.subtle
          .encrypt({ name: "AES-GCM", iv: iv }, cryptoKey, plainBuf)
          .then(function (ciphertext) {
            // Free plaintext reference in this scope
            plainBuf = null;

            var result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
            result.set(iv, 0);
            result.set(new Uint8Array(ciphertext), IV_LENGTH);
            ciphertext = null;

            // Transfer the result -- zero-copy, worker loses the buffer
            self.postMessage(
              { type: "encrypted", encBuf: result.buffer },
              [result.buffer]
            );
          });
      })
      .catch(function (err) {
        self.postMessage({
          type: "error",
          message: err.message || "Encryption failed",
        });
      });
    return;
  }
};
