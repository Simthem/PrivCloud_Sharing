import assert from "node:assert/strict";
import {
  createUserUniqueConflictResponse,
  describeUserUniqueConflict,
} from "./prisma-error.util";

assert.equal(
  describeUserUniqueConflict({ meta: { target: ["username"] } }),
  "username",
);
assert.equal(
  describeUserUniqueConflict({ meta: { constraint: "User_email_key" } }),
  "email",
);
assert.equal(
  describeUserUniqueConflict({ meta: {} }),
  "email or username",
);
assert.equal(
  describeUserUniqueConflict({}),
  "email or username",
);
assert.equal(
  describeUserUniqueConflict({
    meta: {
      driverAdapterError: {
        cause: {
          originalMessage: "UNIQUE constraint failed: User.email",
          constraint: { fields: ["email"] },
        },
      },
    },
  }),
  "email",
);
assert.equal(
  describeUserUniqueConflict({
    meta: {
      driverAdapterError: {
        cause: {
          constraint: { fields: ["userId"] },
        },
      },
    },
  }),
  "email or username",
);
assert.deepEqual(
  createUserUniqueConflictResponse({ meta: {} }),
  {
    code: "user_unique_conflict",
    field: "email or username",
    message: "A user with this email or username already exists",
  },
);

console.log("prisma unique-conflict metadata checks passed");
