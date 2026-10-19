import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { withElapsedNotice } from "./elapsed-notice.mjs"

test("the npm entry point serializes CPU-heavy public measurement files", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  )
  assert.equal(
    manifest.scripts.test,
    "node --test --test-concurrency=1 test/*.test.mjs",
  )
})

test("elapsed notices do not claim progress and stop after success", async (t) => {
  const log = t.mock.method(console, "log", () => {})
  t.mock.timers.enable({ apis: ["setInterval"] })
  const result = await withElapsedNotice("synthetic", async () => {
    t.mock.timers.tick(30_000)
    return 42
  })
  assert.equal(result, 42)
  assert.equal(log.mock.callCount(), 2)
  assert.match(log.mock.calls[1].arguments[0], /not proof of progress/)
  t.mock.timers.tick(60_000)
  assert.equal(log.mock.callCount(), 2)
})

test("elapsed notices preserve failures and stop after rejection", async (t) => {
  const log = t.mock.method(console, "log", () => {})
  t.mock.timers.enable({ apis: ["setInterval"] })
  const failure = new Error("synthetic measurement failure")
  await assert.rejects(
    withElapsedNotice("synthetic", async () => {
      t.mock.timers.tick(30_000)
      throw failure
    }),
    (error) => error === failure,
  )
  t.mock.timers.tick(60_000)
  assert.equal(log.mock.callCount(), 2)
})
