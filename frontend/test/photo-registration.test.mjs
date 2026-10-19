import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { cspOpenCv } from "../scripts/build-photo-registration.mjs"
import { checkRegistrationPixels } from "../src/utils/photoRegistrationCore.util.ts"

test("the pinned OpenCV adapter rejects drift and removes string-generated JavaScript", async () => {
  const require = createRequire(import.meta.url)
  const bytes = await readFile(require.resolve("@techstark/opencv-js"))
  const source = cspOpenCv(bytes)
  assert.doesNotMatch(source, /\b(?:new\s+)?Function\s*\(|\beval\s*\(/)
  assert.match(source, /Reflect\.apply/)
  const altered = Buffer.from(bytes)
  altered[0] ^= 1
  assert.throws(() => cspOpenCv(altered), /Unexpected OpenCV bytes/)
})

test("photo registration rejects invalid or oversized pixel inputs before worker allocation", () => {
  const pixels = { width: 32, height: 32, data: new Uint8ClampedArray(4096) }
  assert.doesNotThrow(() => checkRegistrationPixels(pixels))
  for (const value of [null, { ...pixels, width: Infinity }, { ...pixels, height: 0 }, { ...pixels, data: new Uint8Array(4096) }, { ...pixels, data: new Uint8ClampedArray(4) }, { ...pixels, width: 5000, height: 5000 }])
    assert.throws(() => checkRegistrationPixels(value))
  assert.throws(() => checkRegistrationPixels(pixels, 10))
})
