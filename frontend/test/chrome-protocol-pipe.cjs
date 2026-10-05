const assert = require("node:assert/strict");
const { StringDecoder } = require("node:string_decoder");

function createChromeProtocolPipe(browser, onMessage) {
  const input = browser.stdio[3];
  const output = browser.stdio[4];
  assert.ok(
    input?.writable && output?.readable,
    "Chrome protocol pipes are required",
  );
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  output.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    let separator;
    while ((separator = buffered.indexOf("\0")) !== -1) {
      const message = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 1);
      if (message) onMessage(JSON.parse(message));
    }
  });
  return (message) => input.write(JSON.stringify(message) + "\0");
}

module.exports = { createChromeProtocolPipe };
