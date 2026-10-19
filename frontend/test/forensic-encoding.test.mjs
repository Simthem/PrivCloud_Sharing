import assert from "node:assert/strict"
import test from "node:test"
import { encodePage } from "../src/utils/externalPreviewRaster.util.ts"
import { EXTERNAL_PAGE_MAX_BYTES } from "../src/utils/externalPreviewLayout.util.ts"

test("forensic page encoding preserves pixels instead of using a lossy fallback", async () => {
  const calls = []
  const png = new Blob([new Uint8Array(128)], { type: "image/png" })
  const canvas = {
    toBlob(callback, type) {
      calls.push(type)
      callback(png)
    },
  }
  assert.equal(await encodePage(canvas, true), png)
  assert.deepEqual(calls, ["image/png"])
})

test("an oversized marked page fails before any lossy encoding", async () => {
  const calls = []
  const canvas = {
    toBlob(callback, type) {
      calls.push(type)
      callback(
        new Blob([new Uint8Array(EXTERNAL_PAGE_MAX_BYTES + 1)], { type }),
      )
    },
  }
  await assert.rejects(encodePage(canvas, true), { code: "too_large" })
  assert.deepEqual(calls, ["image/png"])
})
