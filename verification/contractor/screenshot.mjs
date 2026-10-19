import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
const { createChromeProtocolPipe } = createRequire(import.meta.url)(
  "./chrome-protocol-pipe.cjs",
)

/** A real Chrome capture at 100%: one image pixel maps to one CSS/device pixel. */
export function chromeTestArguments(trustedSynthetic = false) {
  if (process.env.PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX !== "1") return []
  assert.ok(
    trustedSynthetic &&
      process.env.CI === "true" &&
      (existsSync("/.dockerenv") ||
        existsSync("/run/.containerenv") ||
        process.env.CI_JOB_IMAGE),
    "Unsandboxed Chrome is restricted to explicit synthetic CI container fixtures",
  )
  return ["--no-sandbox"]
}

export async function screenshot(
  png,
  width,
  height,
  { trustedSynthetic = false } = {},
) {
  assert.ok(
    Buffer.isBuffer(png) &&
      png.length <= 32 * 1024 * 1024 &&
      Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width * height <= 4_000_000,
    "Screenshot input exceeds budget",
  )
  const testArguments = chromeTestArguments(trustedSynthetic)
  const profile = await mkdtemp(join(tmpdir(), "privcloud-watermark-chrome-"))
  let browser,
    id = 0,
    send
  const pending = new Map()
  let stderr = "",
    closed,
    stopped = false
  const fail = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  const stop = async () => {
    if (!browser || stopped) return
    stopped = true
    browser.kill()
    let timer
    await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          browser.kill("SIGKILL")
          resolve()
        }, 2000)
      }),
    ])
    clearTimeout(timer)
  }
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error("Chrome timeout: " + method))
      }, 30000)
      pending.set(requestId, { resolve, reject, timer })
      send({
        id: requestId,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      })
    })
  try {
    browser = spawn(
      process.env.CHROME_PATH || "/usr/bin/google-chrome",
      [
        "--headless=new",
        "--no-first-run",
        "--no-proxy-server",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-extensions",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--disable-dev-shm-usage",
        "--remote-debugging-pipe",
        ...testArguments,
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
      },
    )
    closed = new Promise((resolve) => browser.once("close", resolve))
    browser.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192)
    })
    send = createChromeProtocolPipe(
      browser,
      (message) => {
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        clearTimeout(request.timer)
        message.error
          ? request.reject(new Error(message.error.message))
          : request.resolve(message.result)
      },
      fail,
    )
    const { product } = await call("Browser.getVersion")
    const { targetId } = await call("Target.createTarget", {
      url: "about:blank",
    })
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    })
    await call("Page.enable", {}, sessionId)
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    // A local data document preserves the actual Chrome rendering/capture path
    // without opening a network listener or transmitting fixture pixels.
    const html =
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><body style="margin:0"><img style="display:block" src="data:image/png;base64,' +
      png.toString("base64") +
      '"></body>'
    const { frameTree } = await call("Page.getFrameTree", {}, sessionId)
    await call(
      "Page.setDocumentContent",
      { frameId: frameTree.frame.id, html },
      sessionId,
    )
    for (let i = 0; i < 100; i++) {
      const result = await call(
        "Runtime.evaluate",
        {
          expression:
            "document.images.length === 1 && document.images[0].complete && document.images[0].naturalWidth > 0",
          returnByValue: true,
        },
        sessionId,
      )
      if (result.result.value) break
      if (i === 99) throw new Error("Screenshot image did not load")
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const result = await call(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      },
      sessionId,
    )
    return { png: Buffer.from(result.data, "base64"), browser: product }
  } catch (error) {
    await stop()
    const diagnostic = stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim()
    throw new Error(
      `Chrome capture failed: ${error.message}. Exit ${browser?.exitCode ?? "unknown"}. ${diagnostic}`,
      { cause: error },
    )
  } finally {
    fail(new Error("Screenshot closed"))
    await stop()
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
}
