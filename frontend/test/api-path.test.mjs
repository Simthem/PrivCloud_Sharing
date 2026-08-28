import assert from "node:assert/strict";
import test from "node:test";
import { apiPathSegment } from "../src/utils/apiPath.util.ts";

test("encodes an untrusted value as exactly one API path segment", () => {
  assert.equal(apiPathSegment("team-123"), "team-123");
  assert.equal(
    apiPathSegment("../admin?x=1#fragment"),
    "%2E%2E%2Fadmin%3Fx%3D1%23fragment",
  );
  assert.equal(
    apiPathSegment("https://attacker.invalid/api"),
    "https%3A%2F%2Fattacker%2Einvalid%2Fapi",
  );
});

test("rejects empty, oversized, malformed and non-string path segments", () => {
  for (const value of [
    "",
    "x".repeat(4_097),
    "\ud800",
    ["team", "admin"],
    null,
  ]) {
    assert.throws(() => apiPathSegment(value), TypeError);
  }
});
