import assert from "node:assert/strict";
import { normalizeNotificationPagination } from "../src/teamNotification/teamNotification.service";
import {
  normalizeAccessLogPagination,
  parseConfiguredLimit,
} from "../src/team/team.service";

assert.deepEqual(normalizeNotificationPagination(), { limit: 50, offset: 0 });
assert.deepEqual(normalizeNotificationPagination(Number.NaN, -4), {
  limit: 50,
  offset: 0,
});
assert.deepEqual(normalizeNotificationPagination(0, 12), {
  limit: 1,
  offset: 12,
});
assert.deepEqual(normalizeNotificationPagination(10_000, 2), {
  limit: 100,
  offset: 2,
});
assert.deepEqual(normalizeAccessLogPagination(), { page: 1, limit: 50 });
assert.deepEqual(normalizeAccessLogPagination(-2, Number.NaN), {
  page: 1,
  limit: 50,
});
assert.deepEqual(normalizeAccessLogPagination(1.5, 10_000), {
  page: 1,
  limit: 100,
});
assert.deepEqual(normalizeAccessLogPagination(Number.MAX_SAFE_INTEGER, 0), {
  page: 1_000_000,
  limit: 1,
});
assert.equal(parseConfiguredLimit(undefined, "250"), 250);
assert.equal(Number.isNaN(parseConfiguredLimit("250GB", "0")), true);
assert.equal(
  Number.isNaN(parseConfiguredLimit(String(Number.MAX_SAFE_INTEGER + 1))),
  true,
);
console.log("ok - pagination is finite and bounded");
