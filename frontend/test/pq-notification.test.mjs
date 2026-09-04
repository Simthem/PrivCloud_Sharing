import assert from "node:assert/strict";
import test from "node:test";
import { selectPqNotificationPublicKey } from "../src/utils/pqNotification.util.ts";

test("uses ML-KEM notification encryption only after Team opt-in", () => {
  assert.equal(selectPqNotificationPublicKey(false, "pq-public-key"), null);
  assert.equal(selectPqNotificationPublicKey(true, null), null);
  assert.equal(
    selectPqNotificationPublicKey(true, "pq-public-key"),
    "pq-public-key",
  );
});
