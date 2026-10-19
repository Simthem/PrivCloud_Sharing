const assert = require("node:assert/strict")
const { StringDecoder } = require("node:string_decoder")

function createChromeProtocolPipe(browser, onMessage, onError = () => {}) {
  const input = browser.stdio[3]
  const output = browser.stdio[4]
  assert.ok(
    input?.writable && output?.readable,
    "Chrome protocol pipes are required",
  )
  const decoder = new StringDecoder("utf8")
  let buffered = ""
  let closed = false
  const fail = (error) => {
    if (closed) return
    closed = true
    buffered = ""
    onError(error)
  }
  input.on("error", fail)
  output.on("error", fail)
  output.on("end", () => fail(new Error("Chrome protocol pipe closed")))
  browser.once?.("error", fail)
  browser.once?.("exit", () =>
    fail(new Error("Chrome exited before protocol completion")),
  )
  output.on("data", (chunk) => {
    if (closed) return
    try {
      buffered += decoder.write(chunk)
      if (buffered.length > 32 * 1024 * 1024)
        throw new Error("Chrome protocol frame exceeds budget")
      let separator
      while ((separator = buffered.indexOf("\0")) !== -1) {
        const message = buffered.slice(0, separator)
        buffered = buffered.slice(separator + 1)
        if (message) onMessage(JSON.parse(message))
      }
    } catch (error) {
      fail(error)
    }
  })
  return (message) => {
    if (closed) throw new Error("Chrome protocol is closed")
    return input.write(JSON.stringify(message) + "\0", (error) => {
      if (error) fail(error)
    })
  }
}

module.exports = { createChromeProtocolPipe }
