import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createChromeProtocolPipe } from "./chrome-protocol-pipe.cjs";

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const send = createChromeProtocolPipe(
    { stdio: [null, null, null, input, output] },
    (message) => messages.push(message),
  );
  return { input, output, messages, send };
}

test("Chrome pipe frames commands with a null terminator", () => {
  const { input, send } = fixture();
  const command = {
    id: 1,
    method: "Target.createTarget",
    params: { url: "about:blank" },
  };
  send(command);
  assert.equal(input.read().toString(), JSON.stringify(command) + "\0");
});

test("Chrome pipe handles fragmented UTF-8 and multiple replies in one chunk", () => {
  const { output, messages } = fixture();
  const reply = { id: 1, result: { text: "Équipe 🔒" } };
  const bytes = Buffer.from(JSON.stringify(reply) + "\0");
  for (const byte of bytes.subarray(0, bytes.length - 1))
    output.write(Buffer.from([byte]));
  assert.deepEqual(messages, []);
  const second = {
    method: "Runtime.exceptionThrown",
    params: { text: "fixture" },
  };
  output.write(Buffer.from("\0" + JSON.stringify(second) + "\0"));
  assert.deepEqual(messages, [reply, second]);
});

test("Chrome pipe keeps an incomplete reply until its terminator arrives", () => {
  const { output, messages } = fixture();
  output.write(Buffer.from('{"id":1}\0{"id":'));
  assert.deepEqual(messages, [{ id: 1 }]);
  output.write(Buffer.from("2}\0"));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});
