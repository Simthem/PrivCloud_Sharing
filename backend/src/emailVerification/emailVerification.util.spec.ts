import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertEmailVerificationAccess,
  getEmailVerificationState,
} from "./emailVerification.util";

const requiredAt = new Date("2026-08-01T12:00:00.000Z");

const legacy = getEmailVerificationState(
  { emailVerificationRequiredAt: null, emailVerifiedAt: null },
  new Date("2036-08-01T12:00:00.000Z"),
);
assert.deepEqual(
  {
    required: legacy.required,
    verified: legacy.verified,
    blocked: legacy.blocked,
  },
  { required: false, verified: true, blocked: false },
  "a null requiredAt must remain a permanent legacy exemption",
);

assert.equal(
  getEmailVerificationState(
    { emailVerificationRequiredAt: requiredAt, emailVerifiedAt: null },
    new Date("2026-08-06T11:59:59.999Z"),
  ).blocked,
  false,
  "new accounts retain access throughout the five-day grace period",
);

assert.throws(
  () =>
    assertEmailVerificationAccess(
      { emailVerificationRequiredAt: requiredAt, emailVerifiedAt: null },
      new Date("2026-08-06T12:00:00.000Z"),
    ),
  /Verify your email address/,
  "access must be blocked exactly at the five-day boundary",
);

assert.equal(
  getEmailVerificationState(
    {
      emailVerificationRequiredAt: requiredAt,
      emailVerifiedAt: new Date("2026-08-02T12:00:00.000Z"),
    },
    new Date("2036-08-01T12:00:00.000Z"),
  ).blocked,
  false,
  "verified accounts must never be blocked by this policy",
);

const migration = readFileSync(
  path.resolve(
    "prisma/migrations/20260827140000_add_email_verification/migration.sql",
  ),
  "utf8",
);
const migrationBeforeInsertTrigger = migration.split("CREATE TRIGGER")[0];
assert.doesNotMatch(
  migrationBeforeInsertTrigger,
  /UPDATE\s+"User"/i,
  "the migration must never backfill existing users",
);
assert.match(
  migration,
  /User_require_email_verification_on_insert/,
  "new inserts must be protected during a rolling deployment",
);

console.log("6 email verification policy and migration tests passed");
