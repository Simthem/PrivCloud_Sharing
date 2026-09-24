import assert from "node:assert/strict";
import test from "node:test";
import { describePasskeyError } from "../src/utils/passkeyError.util.ts";

const domError = (name) => Object.assign(new Error(name), { name });

test("names the cause of a failed passkey ceremony", () => {
  assert.equal(describePasskeyError(domError("SecurityError")).reason, "domain");
  assert.equal(describePasskeyError(domError("NotAllowedError")).reason, "cancelled");
  assert.equal(describePasskeyError(domError("InvalidStateError")).reason, "already-registered");
  assert.equal(describePasskeyError(domError("NotSupportedError")).reason, "unsupported");
  assert.deepEqual(
    describePasskeyError({ response: { data: { message: "Passkey user verification is required" } } }),
    { reason: "server", detail: "Passkey user verification is required" },
  );
  assert.equal(describePasskeyError(domError("WeirdError")).detail, "WeirdError");
  assert.equal(
    describePasskeyError({ response: { status: 409, data: { message: "The document changed after confirmation began" } } }).reason,
    "stale",
  );
  assert.equal(
    describePasskeyError({ response: { status: 400, data: { message: "Passkey challenge is invalid or expired" } } }).reason,
    "stale",
  );
});
