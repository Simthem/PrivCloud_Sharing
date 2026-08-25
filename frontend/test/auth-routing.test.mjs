import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSignInRedirectPath,
  finalizePostAuthRedirectPath,
  getRememberedPostAuthRedirectPath,
  isProtectedTeamContextPath,
  isTeamInvitationRoutePath,
  isTeamRoutePath,
  isTeamScopedUploadPath,
  rememberPostAuthRedirectTarget,
  safeRedirectPath,
  shouldRequireClassicUploadAuthentication,
} from "../src/utils/authRedirect.util.ts";

test("never downgrades a deleted or expired upload session to anonymous mode", () => {
  assert.equal(
    shouldRequireClassicUploadAuthentication(true, true, true),
    true,
  );
  assert.equal(
    shouldRequireClassicUploadAuthentication(true, false, false),
    true,
  );
  assert.equal(
    shouldRequireClassicUploadAuthentication(true, true, false),
    false,
  );
  assert.equal(
    shouldRequireClassicUploadAuthentication(false, false, true),
    false,
  );
});

test("matches only the /team route family", () => {
  assert.equal(isTeamRoutePath("/team"), true);
  assert.equal(isTeamRoutePath("/team/new"), true);
  assert.equal(isTeamRoutePath("/team/invite/[token]"), true);
  assert.equal(isTeamRoutePath("/team/[id]/folder/[folderId]"), true);
  assert.equal(isTeamRoutePath("/teams"), false);
  assert.equal(isTeamRoutePath("/teamwork"), false);
  assert.equal(isTeamInvitationRoutePath("/team/invite/[token]"), true);
  assert.equal(isTeamInvitationRoutePath("/team/[id]"), false);
});

test("protects only Team-scoped uploads", () => {
  for (const publicUpload of [
    "/upload",
    "/upload?recipient=test@example.com",
    "/upload?team=marketing",
  ]) {
    assert.equal(isTeamScopedUploadPath(publicUpload), false);
    assert.equal(isProtectedTeamContextPath(publicUpload), false);
  }

  for (const teamUpload of [
    "/upload?teamId=team-1",
    "/upload?teamFolderId=folder-1",
    "/upload?teamId=team-1&teamFolderId=folder-1",
    "/upload?teamFolderId=&source=folder",
  ]) {
    assert.equal(isTeamScopedUploadPath(teamUpload), true);
    assert.equal(isProtectedTeamContextPath(teamUpload), true);
  }

  assert.equal(isProtectedTeamContextPath("/team/team-1/settings"), true);
  assert.equal(isProtectedTeamContextPath("/teamwork?teamId=team-1"), false);
});

test("accepts same-origin return paths and rejects open redirects", () => {
  assert.equal(
    safeRedirectPath("/team/abc/folder/def?tab=files"),
    "/team/abc/folder/def?tab=files",
  );
  for (const unsafe of [
    "//evil.example/team",
    "/\\evil.example/team",
    "https://evil.example/team",
    "javascript:alert(1)",
    "team/abc",
  ]) {
    assert.equal(safeRedirectPath(unsafe), "/");
  }
});

test("never moves a Team E2E key fragment into the sign-in request URL", () => {
  const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
  const signInPath = buildSignInRedirectPath(
    `/team/invite/token?source=email#teamKey=${secret}&version=2`,
  );
  const parsed = new URL(signInPath, "https://privcloud.example");

  assert.equal(parsed.pathname, "/auth/signIn");
  assert.equal(
    parsed.searchParams.get("redirect"),
    "/team/invite/token?source=email",
  );
  assert.equal(parsed.hash, "");
  assert.equal(signInPath.includes(secret), false);
});

test("keeps a Team E2E fragment in per-tab storage and restores it once", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    },
  };

  try {
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
    const target = `/team/invite/token#teamKey=${secret}&version=3`;

    rememberPostAuthRedirectTarget(target);
    assert.equal(getRememberedPostAuthRedirectPath(), "/team/invite/token");
    assert.equal(finalizePostAuthRedirectPath("/team/invite/token"), target);
    assert.equal(
      finalizePostAuthRedirectPath("/team/invite/token"),
      "/team/invite/token",
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});
