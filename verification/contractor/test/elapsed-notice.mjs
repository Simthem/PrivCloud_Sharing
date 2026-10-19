export async function withElapsedNotice(label, operation) {
  const started = performance.now()
  console.log(`[${label}] Starting a complete measurement, no verdict yet`)
  const timer = setInterval(() => {
    const seconds = Math.round((performance.now() - started) / 1000)
    console.log(
      `[${label}] Still awaiting the result after ${seconds}s, elapsed time is not proof of progress`,
    )
  }, 30_000)
  timer.unref()
  try {
    return await operation()
  } finally {
    clearInterval(timer)
  }
}
