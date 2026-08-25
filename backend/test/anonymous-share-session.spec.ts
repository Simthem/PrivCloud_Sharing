import assert from "node:assert/strict";
import {
  anonymousShareSessionCookieName,
  anonymousShareSessionCookiePath,
} from "src/share/anonymous-share-session.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("anonymous share sessions");

testCase("scopes ownership cookies independently to each share", () => {
  assert.equal(
    anonymousShareSessionCookieName("share-a"),
    "anonymous_share_share-a_session",
  );
  assert.equal(
    anonymousShareSessionCookieName("share-b"),
    "anonymous_share_share-b_session",
  );
  assert.notEqual(
    anonymousShareSessionCookieName("share-a"),
    anonymousShareSessionCookieName("share-b"),
  );
  assert.equal(
    anonymousShareSessionCookiePath("share-a"),
    "/api/shares/share-a",
  );
});

void run();
