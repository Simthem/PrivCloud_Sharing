import assert from "node:assert/strict";
import { nextLoginFailureState } from "src/auth/loginBackoff.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("login backoff");
const policy = {
  maxFailures: 5,
  baseLockMinutes: 3,
  maxLockMinutes: 60,
  failureWindowMinutes: 30,
};
const now = new Date("2026-09-19T12:00:00.000Z");

testCase("locks on the configured threshold and doubles subsequent delays", () => {
  const initial = nextLoginFailureState({
    previousAttempts: 4,
    lastFailedLoginAt: new Date(now.getTime() - 60_000),
    now,
    policy,
  });
  assert.equal(initial.attempts, 5);
  assert.equal(initial.retryAfterSeconds, 180);
  assert.equal(initial.lockedUntil?.toISOString(), "2026-09-19T12:03:00.000Z");

  const repeated = nextLoginFailureState({
    previousAttempts: initial.attempts,
    lastFailedLoginAt: initial.lastFailedLoginAt,
    now,
    policy,
  });
  assert.equal(repeated.attempts, 6);
  assert.equal(repeated.retryAfterSeconds, 360);
});

testCase("caps delays and forgets failures outside the rolling window", () => {
  const capped = nextLoginFailureState({
    previousAttempts: 20,
    lastFailedLoginAt: new Date(now.getTime() - 60_000),
    now,
    policy,
  });
  assert.equal(capped.retryAfterSeconds, 3600);

  const expired = nextLoginFailureState({
    previousAttempts: 20,
    lastFailedLoginAt: new Date(now.getTime() - 31 * 60_000),
    now,
    policy,
  });
  assert.equal(expired.attempts, 1);
  assert.equal(expired.lockedUntil, null);
});

testCase("starts the quiet window after an enforced lock expires", () => {
  const escalated = nextLoginFailureState({
    previousAttempts: 10,
    lastFailedLoginAt: new Date(now.getTime() - 61 * 60_000),
    previousLockedUntil: new Date(now.getTime() - 60_000),
    now,
    policy,
  });
  assert.equal(escalated.attempts, 11);
  assert.equal(escalated.retryAfterSeconds, 3600);
});

void run();
