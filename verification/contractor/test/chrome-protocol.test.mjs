import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import test from "node:test"
import { chromeTestArguments } from "../screenshot.mjs"
const { createChromeProtocolPipe } = createRequire(import.meta.url)(
  "../chrome-protocol-pipe.cjs",
)

test("Chrome pipe errors settle once instead of escaping as unhandled ECONNRESET", () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    browser = new EventEmitter()
  browser.stdio = [null, null, null, input, output]
  const errors = [],
    replies = []
  const send = createChromeProtocolPipe(
    browser,
    (reply) => replies.push(reply),
    (error) => errors.push(error),
  )
  const failure = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  })
  output.emit("error", failure)
  input.emit("error", new Error("EPIPE"))
  browser.emit("exit", 1)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, "ECONNRESET")
  assert.throws(() => send({ id: 1 }), /closed/)
  assert.deepEqual(replies, [])
})

test("invalid Chrome frames fail without throwing from the stream listener", () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    errors = []
  createChromeProtocolPipe(
    { stdio: [null, null, null, input, output] },
    () => {},
    (error) => errors.push(error),
  )
  output.write("not-json\0")
  assert.equal(errors.length, 1)
})

test("the sandbox exception needs an explicit synthetic CI container context", () => {
  const previous = process.env.PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX
  const ci = process.env.CI
  try {
    delete process.env.PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX
    assert.deepEqual(chromeTestArguments(), [])
    process.env.PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX = "1"
    delete process.env.CI
    assert.throws(() => chromeTestArguments(true), /restricted/)
    process.env.CI = "true"
    assert.throws(() => chromeTestArguments(false), /restricted/)
  } finally {
    if (previous === undefined)
      delete process.env.PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX
    else process.env.PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX = previous
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
  }
})

test("a Chrome launch failure reports its cause promptly without a dangling timeout", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {screenshot} from "./screenshot.mjs";try{await screenshot(Buffer.from("fixture"),320,256)}catch(error){console.error(error.message);process.exitCode=1}',
    ],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        CHROME_PATH: "/nonexistent-privcloud-chrome",
        LANG: "C.UTF-8",
      },
    },
  )
  assert.equal(child.status, 1)
  assert.notEqual(child.error?.code, "ETIMEDOUT")
  assert.match(child.stderr, /Chrome capture failed:.*ENOENT/)
  assert.doesNotMatch(child.stderr, /Unhandled|uncaught/)
})
