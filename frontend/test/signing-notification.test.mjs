import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSigningNotificationActions,
  isSafeSigningNotificationAction,
} from "../src/utils/signingNotification.util.ts";

test("keeps the E2E key inside encrypted signing notification actions", () => {
  const key = "team_key_1234567890";
  const actions = buildSigningNotificationActions("recipient-token", key);
  assert.equal(actions.invitation, `/sign/recipient-token#key=${key}`);
  assert.equal(
    actions.completion,
    `/sign/recipient-token?download=1#key=${key}`,
  );
  assert.equal(isSafeSigningNotificationAction(actions.invitation), true);
  assert.equal(isSafeSigningNotificationAction(actions.completion), true);
});

test("never adds a malformed E2E key to a notification action", () => {
  const actions = buildSigningNotificationActions(
    "recipient-token",
    "unsafe#fragment",
  );
  assert.equal(actions.invitation, "/sign/recipient-token");
  assert.equal(actions.completion, "/sign/recipient-token?download=1");
  assert.equal(
    isSafeSigningNotificationAction(
      "/sign/recipient-token?download=1#key=unsafe&redirect=evil",
    ),
    false,
  );
});
