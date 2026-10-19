import test from "node:test";
import assert from "node:assert/strict";
import { rotationDaysRemaining } from "../src/utils/teamRotationSchedule.util.ts";
test("rotation countdown rounds partial days up and handles overdue deadlines", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(rotationDaysRemaining("2026-10-07T12:00:01Z", now), 2);
  assert.equal(rotationDaysRemaining("2026-10-07T12:00:00Z", now), 1);
  assert.equal(rotationDaysRemaining("2026-10-06T12:00:01Z", now), 1);
  assert.equal(rotationDaysRemaining("2026-10-06T12:00:00Z", now), 0);
  assert.equal(rotationDaysRemaining("2026-09-01T12:00:00Z", now), 0);
  assert.equal(rotationDaysRemaining("bad", now), null);
});
