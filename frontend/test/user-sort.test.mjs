import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_USER_SORT, sortUsers } from "../src/utils/userSort.util.ts";

const user = (id, overrides) => ({
  id,
  username: id,
  email: `${id}@example.test`,
  isAdmin: false,
  ...overrides,
});

const users = [
  user("carol", {
    createdAt: "2026-03-01T00:00:00.000Z",
    shareQuotaUsed: 4,
  }),
  user("Alice", {
    createdAt: "2026-01-01T00:00:00.000Z",
    shareQuotaUsed: 9,
  }),
  user("bob", {
    createdAt: "2026-02-01T00:00:00.000Z",
    isAdmin: true,
  }),
];
const ids = (sorted) => sorted.map(({ id }) => id);

test("users start from the oldest signup", () => {
  assert.deepEqual(ids(sortUsers(users, DEFAULT_USER_SORT)), [
    "Alice",
    "bob",
    "carol",
  ]);
  assert.deepEqual(
    ids(sortUsers(users, { field: "created", direction: "desc" })),
    ["carol", "bob", "Alice"],
  );
});

test("sorting leaves the given list untouched", () => {
  const before = ids(users);
  sortUsers(users, DEFAULT_USER_SORT);
  assert.deepEqual(ids(users), before);
});

test("names ignore case", () => {
  assert.deepEqual(
    ids(sortUsers(users, { field: "username", direction: "asc" })),
    ["Alice", "bob", "carol"],
  );
});

test("equal values keep the signup order", () => {
  assert.deepEqual(
    ids(sortUsers(users, { field: "admin", direction: "asc" })),
    ["Alice", "carol", "bob"],
  );
  assert.deepEqual(
    ids(sortUsers(users, { field: "admin", direction: "desc" })),
    ["bob", "Alice", "carol"],
  );
});
