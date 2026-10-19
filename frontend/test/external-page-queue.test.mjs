import assert from "node:assert/strict"
import test from "node:test"
import { createExternalPageQueue } from "../src/utils/externalPageQueue.util.ts"
const next = () => new Promise((resolve) => setImmediate(resolve))

test("page loads stay bounded and the viewport overtakes queued prefetches", async () => {
  const queue = createExternalPageQueue(1),
    controller = new AbortController()
  let release
  const order = []
  const first = queue.run(
    () => 1,
    controller.signal,
    () =>
      new Promise((resolve) => {
        order.push("first")
        release = resolve
      }),
  )
  await next()
  const far = queue.run(
    () => 1000,
    controller.signal,
    async () => {
      order.push("far")
      return 2
    },
  )
  const visible = queue.run(
    () => -1000,
    controller.signal,
    async () => {
      order.push("visible")
      return 3
    },
  )
  assert.deepEqual(order, ["first"])
  release(1)
  assert.deepEqual(await Promise.all([first, far, visible]), [1, 2, 3])
  assert.deepEqual(order, ["first", "visible", "far"])
  queue.close()
})

test("aborting a queued page never fetches it or blocks subsequent pages", async () => {
  const queue = createExternalPageQueue(1),
    active = new AbortController(),
    queued = new AbortController()
  let release,
    fetched = false
  const first = queue.run(
    () => 0,
    active.signal,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await next()
  const cancelled = queue.run(
    () => 0,
    queued.signal,
    async () => {
      fetched = true
    },
  )
  queued.abort()
  await assert.rejects(cancelled, { name: "AbortError" })
  release(42)
  assert.equal(await first, 42)
  assert.equal(fetched, false)
  assert.equal(
    await queue.run(
      () => 0,
      active.signal,
      async () => 7,
    ),
    7,
  )
  queue.close()
})

test("closing a page queue aborts active work and rejects waiting work", async () => {
  const queue = createExternalPageQueue(1),
    external = new AbortController()
  let received
  const first = queue.run(
    () => 0,
    external.signal,
    (signal) =>
      new Promise((resolve, reject) => {
        received = signal
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Stopped", "AbortError")),
          { once: true },
        )
      }),
  )
  await next()
  const second = queue.run(
    () => 0,
    external.signal,
    async () => 99,
  )
  const failures = Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ])
  queue.close()
  await failures
  assert.equal(received.aborted, true)
  await assert.rejects(
    queue.run(
      () => 0,
      external.signal,
      async () => 1,
    ),
    { name: "AbortError" },
  )
})

test("a failed transfer does not starve the next page", async () => {
  const queue = createExternalPageQueue(1),
    controller = new AbortController()
  await assert.rejects(
    queue.run(
      () => 0,
      controller.signal,
      async () => {
        throw new Error("Storage unavailable")
      },
    ),
    /Storage unavailable/,
  )
  assert.equal(
    await queue.run(
      () => 0,
      controller.signal,
      async () => 12,
    ),
    12,
  )
  queue.close()
  for (const maximum of [0, -1, 1.5, 5])
    assert.throws(() => createExternalPageQueue(maximum))
})
