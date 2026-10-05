import assert from "node:assert/strict";
import test from "node:test";

import { isTrustedWorkerResultEvent } from "../src/utils/reencryptWorkerMessage.util.ts";

const trustedEvent = (worker, data, overrides = {}) => ({
  data,
  origin: "",
  isTrusted: true,
  currentTarget: worker,
  target: worker,
  ...overrides,
});

test("accepts results only from the exact trusted re-encryption Worker", () => {
  const activeWorker = {};
  const validResult = { type: "result", requestId: 1, ok: true };

  assert.equal(
    isTrustedWorkerResultEvent(
      trustedEvent(activeWorker, validResult),
      activeWorker,
    ),
    true,
  );

  for (const event of [
    trustedEvent(activeWorker, validResult, {
      origin: "https://evil.example",
    }),
    trustedEvent(activeWorker, validResult, { isTrusted: false }),
    trustedEvent(activeWorker, validResult, { currentTarget: {} }),
    trustedEvent(activeWorker, validResult, { target: {} }),
    trustedEvent(activeWorker, { ...validResult, requestId: "__proto__" }),
    trustedEvent(activeWorker, { ...validResult, status: 600 }),
    trustedEvent(activeWorker, null),
  ]) {
    assert.equal(
      isTrustedWorkerResultEvent(event, activeWorker),
      false,
    );
  }
});
