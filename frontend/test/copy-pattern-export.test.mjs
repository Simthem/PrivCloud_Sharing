import assert from "node:assert/strict"
import test from "node:test"
import {
  exportCopyPattern,
  parseCopyPattern,
} from "../src/utils/copyPatternExport.util.ts"
import { markPattern } from "../src/utils/forensicMark.util.ts"

test("per-copy diagnostics contain exactly the derived pattern and declared carrier, never the audit key or identity", async () => {
  const key = new Uint8Array(32).fill(37)
  const id = "a".repeat(32)
  const encoded = await exportCopyPattern(
    key,
    id,
    "privcloud:forensic-multiscale:v2",
  )
  assert.deepEqual(Object.keys(JSON.parse(encoded)).sort(), [
    "format",
    "markId",
    "pattern",
    "robust",
  ])
  const decoded = parseCopyPattern(encoded)
  assert.equal(decoded.markId, id)
  assert.equal(decoded.robust, true)
  assert.deepEqual(decoded.pattern, await markPattern(key, id))
  assert.ok(
    key.every((value) => value === 37),
    "the caller owns and clears its key",
  )
  assert.equal(parseCopyPattern(await exportCopyPattern(key, id)).robust, false)
})

test("copy diagnostics reject key fields, unknown versions, invalid numbers and excess input", async () => {
  const key = new Uint8Array(32).fill(37)
  const valid = JSON.parse(await exportCopyPattern(key, "a".repeat(32)))
  for (const value of [
    null,
    { ...valid, auditKey: [1] },
    { ...valid, markId: "../copy" },
    { ...valid, robust: 1 },
    { ...valid, pattern: [1] },
    { ...valid, pattern: Array(128 * 128).fill(2) },
  ])
    assert.throws(() => parseCopyPattern(JSON.stringify(value)))
  assert.throws(() => parseCopyPattern(" ".repeat(512 * 1024 + 1)))
  assert.throws(() =>
    parseCopyPattern(
      JSON.stringify(valid).replace(
        '"robust":false',
        '"robust":true,"robust":false',
      ),
    ),
  )
  await assert.rejects(exportCopyPattern(key, "a".repeat(32), "unknown"))
})
