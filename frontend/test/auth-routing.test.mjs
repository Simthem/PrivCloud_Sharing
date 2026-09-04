import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  buildExpiredSessionSignInPath,
  buildSignInRedirectPath,
  finalizePostAuthRedirectPath,
  getRememberedPostAuthRedirectPath,
  isEmailVerificationRoutePath,
  isProtectedTeamContextPath,
  isSessionScopedRoutePath,
  isTeamInvitationRoutePath,
  isTeamRoutePath,
  isTeamScopedUploadPath,
  rememberPostAuthRedirectTarget,
  safeRedirectPath,
  shouldRequireClassicUploadAuthentication,
} from "../src/utils/authRedirect.util.ts";
import { refreshAfterPossibleCookieRotation } from "../src/utils/authRefresh.util.ts";

test("retries only a 401 and never consumes SafeLine or transient failures", async () => {
  for (const status of [0, 403, 468, 500]) {
    let attempts = 0;
    const result = await refreshAfterPossibleCookieRotation(async () => {
      attempts++;
      return { ok: false, status };
    }, 0);
    assert.deepEqual(result, { ok: false, status });
    assert.equal(attempts, 1);
  }

  let attempts = 0;
  await refreshAfterPossibleCookieRotation(async () => {
    attempts++;
    return { ok: false, status: 401 };
  }, 0);
  assert.equal(attempts, 2);
});

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

test("keeps the verification page reachable in an authenticated session", () => {
  assert.equal(isEmailVerificationRoutePath("/auth/verify-email"), true);
  assert.equal(isEmailVerificationRoutePath("/auth/signIn"), false);
  assert.equal(isEmailVerificationRoutePath("/auth/verify-email/extra"), false);
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

test("marks an expired-session redirect without exposing a URL fragment", () => {
  const path = buildExpiredSessionSignInPath(
    "/team/acme?tab=files#teamKey=AbCdEfGhIjKlMnOp&version=1",
  );
  const parsed = new URL(path, "https://privcloud.example");

  assert.equal(parsed.pathname, "/auth/signIn");
  assert.equal(parsed.searchParams.get("redirect"), "/team/acme?tab=files");
  assert.equal(parsed.searchParams.get("error"), "session-expired");
  assert.equal(parsed.hash, "");
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

test("keeps a signing E2E fragment out of the sign-in URL and restores it", () => {
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
    const keyFragment = randomBytes(32).toString("base64url");
    const target = `/sign/token-1#key=${keyFragment}`;
    const signInPath = buildSignInRedirectPath(target);
    assert.equal(signInPath.includes(keyFragment), false);

    rememberPostAuthRedirectTarget(target);
    assert.equal(getRememberedPostAuthRedirectPath(), "/sign/token-1");
    assert.equal(finalizePostAuthRedirectPath("/sign/token-1"), target);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("the sign-in page cannot overwrite a stored signing key with its hashless URL", () => {
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
    const keyFragment = randomBytes(32).toString("base64url");
    const target = `/sign/reinforced-token#key=${keyFragment}`;
    rememberPostAuthRedirectTarget(target);

    // Mirrors /auth/signIn after Next.js removed the source page's fragment.
    rememberPostAuthRedirectTarget("/sign/reinforced-token", {
      preserveExistingFragmentForSamePath: true,
    });

    assert.equal(
      finalizePostAuthRedirectPath("/sign/reinforced-token"),
      target,
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("gates only session-scoped routes behind the client-side session probe", () => {
  for (const pathname of [
    "/account",
    "/account/reverseShares",
    "/admin",
    "/admin/config/[category]",
    "/team",
    "/team/[teamId]",
  ]) {
    assert.equal(isSessionScopedRoutePath(pathname), true, pathname);
  }

  // Public and anonymous-capable routes must keep rendering without waiting
  // for a session, and a shared prefix must not be mistaken for a segment.
  for (const pathname of [
    "/",
    "/upload",
    "/auth/signIn",
    "/s/[token]",
    "/accounts",
    "/teams",
    "/administration",
    undefined,
    null,
    "",
  ]) {
    assert.equal(isSessionScopedRoutePath(pathname), false, String(pathname));
  }
});
