type Job = {
  priority: () => number
  controller: AbortController
  start: () => void
  cancel: () => void
}

/** Bound transfers/decodes and prefer the viewport over earlier prefetches. */
export function createExternalPageQueue(maximum = 2) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4)
    throw new Error("Invalid page concurrency")
  const waiting: Job[] = []
  const running = new Set<Job>()
  let closed = false
  const drain = () => {
    if (closed) return
    waiting.sort((a, b) => a.priority() - b.priority())
    while (running.size < maximum && waiting.length) {
      const job = waiting.shift()!
      running.add(job)
      job.start()
    }
  }
  const run = <T>(
    priority: () => number,
    signal: AbortSignal,
    operation: (_signal: AbortSignal) => Promise<T>,
  ) =>
    new Promise<T>((resolve, reject) => {
      if (closed || signal.aborted) {
        reject(new DOMException("Page loading stopped", "AbortError"))
        return
      }
      const controller = new AbortController()
      const cancel = () => {
        controller.abort()
        const index = waiting.indexOf(job)
        if (index >= 0) waiting.splice(index, 1)
        signal.removeEventListener("abort", cancel)
        reject(new DOMException("Page loading stopped", "AbortError"))
      }
      const job: Job = {
        priority: () => {
          const value = priority()
          return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
        },
        controller,
        cancel,
        start: () => {
          void Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted()
              return operation(controller.signal)
            })
            .then(resolve, reject)
            .finally(() => {
              signal.removeEventListener("abort", cancel)
              running.delete(job)
              drain()
            })
        },
      }
      signal.addEventListener("abort", cancel, { once: true })
      waiting.push(job)
      drain()
    })
  return {
    run,
    close: () => {
      if (closed) return
      closed = true
      for (const job of [...waiting, ...running]) job.cancel()
      waiting.length = 0
    },
  }
}
