import assert from "node:assert/strict";
import test from "node:test";
import { parseEmailChangeFragment } from "../src/utils/emailChange.util.ts";
import { shouldRedirectAuthenticatedEntryPath } from "../src/utils/authRedirect.util.ts";
import { isReauthenticationRefusal } from "../src/utils/authRefresh.util.ts";

test("email change accepts exactly one action and one bounded token", () => {
  const token = "a".repeat(43);
  for (const action of ["confirm", "cancel"])
    assert.deepEqual(
      parseEmailChangeFragment(`#token=${token}&action=${action}`),
      { token, action },
    );
  for (const value of [
    "",
    `action=confirm&token=${token}`,
    `#action=confirm&token=${token}&token=${token}`,
    `#action=cancel&token=${token}&extra=1`,
    `#action=confirm&action=cancel&token=${token}`,
    "#action=confirm&token=short",
    `#action=other&token=${token}`,
  ])
    assert.equal(parseEmailChangeFragment(value), null);
});

test("session recovery must preserve email change links", () => {
  assert.equal(
    shouldRedirectAuthenticatedEntryPath("/auth/change-email"),
    false,
  );
  assert.equal(
    shouldRedirectAuthenticatedEntryPath("/auth/change-email/extra"),
    true,
  );
  assert.equal(shouldRedirectAuthenticatedEntryPath("/auth/signIn"), true);
  assert.equal(shouldRedirectAuthenticatedEntryPath("/"), true);
  assert.equal(shouldRedirectAuthenticatedEntryPath("/account"), false);
});

test("a refused password or 2FA code is not replayed after a token refresh", () => {
  for (const url of [
    "/auth/password",
    "auth/email-change",
    "/auth/totp/enable",
    "/auth/totp/verify",
    "/auth/totp/disable",
    "auth/passkey/registration",
    "/auth/password?retry=1",
  ]) {
    assert.equal(isReauthenticationRefusal(403, url), true, url);
  }
  // An expired session, and every other route, keep the refresh and replay.
  assert.equal(isReauthenticationRefusal(401, "/auth/password"), false);
  for (const url of [
    "/auth/email-change/confirm",
    "/auth/passwordless",
    "/shares/abc",
    "/users/me",
    undefined,
  ]) {
    assert.equal(isReauthenticationRefusal(403, url), false, String(url));
  }
});
