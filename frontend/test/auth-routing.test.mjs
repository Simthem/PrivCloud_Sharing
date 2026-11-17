import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  buildExpiredSessionSignInPath,
  buildSignInRedirectPath,
  finalizePostAuthRedirectPath,
  getRememberedPostAuthRedirectPath,
  isBrowserLanguageRoutePath,
  isChosenLanguage,
  languageParameter,
  redirectLocale,
  isEmailVerificationRoutePath,
  isProtectedTeamContextPath,
  isSessionScopedRoutePath,
  isTeamInvitationRoutePath,
  markOAuthSignIn,
  isTeamRoutePath,
  isTeamScopedUploadPath,
  prefersEnglish,
  rememberPostAuthRedirectTarget,
  safeRedirectPath,
  shouldRequireClassicUploadAuthentication,
  takeOAuthSignInMark,
} from "../src/utils/authRedirect.util.ts";
import {
  rememberVerificationReturn,
  takeVerificationReturn,
} from "../src/utils/emailVerification.util.ts";
import { resolvePostAuthRedirectPath } from "../src/utils/router.util.ts";
import i18nUtil from "../src/utils/i18n.util.ts";
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
  const secret = randomBytes(32).toString("base64url");
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
    `/team/acme?tab=files#teamKey=${randomBytes(32).toString("base64url")}&version=1`,
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
    const secret = randomBytes(32).toString("base64url");
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
test("application pages follow the browser language, SEO pages do not", () => {
  for (const path of [
    "/auth/signIn",
    "/team/invite/token",
    "/external/invite/token",
    "/account",
    "/s/share-id",
    "/sign/token",
  ]) {
    assert.equal(isBrowserLanguageRoutePath(path), true, path);
  }
  for (const path of ["/", "/blog", "/blog/article", "/pricing", undefined]) {
    assert.equal(isBrowserLanguageRoutePath(path), false, String(path));
  }
});

test("the first language of the browser decides between French and English", () => {
  assert.equal(prefersEnglish("en-US,en;q=0.9,fr;q=0.8"), true);
  assert.equal(prefersEnglish("de-DE,de;q=0.9"), true);
  assert.equal(prefersEnglish("fr-FR,fr;q=0.9,en;q=0.8"), false);
  assert.equal(prefersEnglish("*"), false);
  assert.equal(prefersEnglish(""), false);
  assert.equal(prefersEnglish(null), false);
});

const ENGLISH_BROWSER = "en-GB,en;q=0.9";
const FRENCH_BROWSER = "fr-FR,fr;q=0.9,en;q=0.8";
const route = (overrides) =>
  redirectLocale({
    locale: "fr",
    pathname: "/share/share-id",
    chosen: false,
    acceptLanguage: ENGLISH_BROWSER,
    ...overrides,
  });

test("a language written on a first visit is not a choice", () => {
  assert.equal(isChosenLanguage("fr-FR"), false);
  assert.equal(isChosenLanguage("en-US", undefined), false);
  assert.equal(isChosenLanguage("fr-FR", "1"), true);
  assert.equal(isChosenLanguage("de-DE"), true);
  assert.equal(isChosenLanguage(undefined, "1"), false);
  assert.equal(isChosenLanguage("", "1"), false);
});

test("a recipient left with a French cookie follows an English browser", () => {
  assert.equal(route({ cookie: "fr-FR" }), "en");
  assert.equal(route({ cookie: undefined }), "en");
  assert.equal(route({ cookie: "fr-FR", locale: "en" }), undefined);
  assert.equal(
    route({ cookie: "en-US", acceptLanguage: FRENCH_BROWSER }),
    undefined,
  );
  assert.equal(route({ cookie: "fr-FR", pathname: "/sign/token" }), "en");
});

test("a language picked in the account wins over the browser", () => {
  assert.equal(route({ cookie: "fr-FR", chosen: true }), undefined);
  assert.equal(route({ cookie: "fr-FR", chosen: true, locale: "en" }), "fr");
  assert.equal(
    route({ cookie: "en-US", chosen: true, acceptLanguage: FRENCH_BROWSER }),
    "en",
  );
  assert.equal(route({ cookie: "de-DE", chosen: true }), undefined);
});

test("a link can ask for its language, whatever the recipient has", () => {
  for (const visitor of [
    { cookie: "fr-FR", chosen: true },
    { cookie: "fr-FR" },
    { acceptLanguage: FRENCH_BROWSER },
  ]) {
    assert.equal(route({ parameter: "en", ...visitor }), "en");
    assert.equal(route({ parameter: "en-US", ...visitor }), "en");
    assert.equal(
      route({ parameter: "en", locale: "en", ...visitor }),
      undefined,
    );
  }
  assert.equal(route({ parameter: "fr", locale: "en" }), "fr");
  assert.equal(route({ parameter: "fr" }), undefined);
  assert.equal(route({ parameter: "de" }), undefined);
  assert.equal(
    route({ parameter: "de", cookie: "en-US", chosen: true }),
    undefined,
  );
});

test("a malformed language parameter is ignored", () => {
  for (const value of [
    "english",
    "e",
    "en_US",
    "../en",
    "en%0d",
    "",
    null,
    ["en"],
    5,
  ]) {
    assert.equal(languageParameter(value), undefined, String(value));
  }
  assert.equal(languageParameter("en"), "en");
  assert.equal(languageParameter("pt-BR"), "pt-BR");
  assert.equal(
    route({ parameter: "english", cookie: "fr-FR", chosen: true }),
    undefined,
  );
  assert.equal(route({ parameter: "//evil.test" }), "en");
});

test("SEO pages keep the URL language, then the last visit", () => {
  const seo = (overrides) => route({ pathname: "/blog/article", ...overrides });
  assert.equal(seo({}), undefined);
  assert.equal(seo({ cookie: "en-US" }), "en");
  assert.equal(seo({ cookie: "fr-FR", locale: "en" }), "fr");
  assert.equal(seo({ cookie: "de-DE" }), undefined);
  assert.equal(seo({ parameter: "en", cookie: "fr-FR" }), "en");
});

test("a page is rendered in the link, cookie or URL language, in that order", () => {
  const page = i18nUtil.pageLanguage;
  assert.equal(page({ locale: "fr" }), "fr-FR");
  assert.equal(page({ locale: "en" }), "en-US");
  assert.equal(page({ locale: "en", cookie: "fr-FR" }), "en-US");
  assert.equal(page({ locale: "fr", cookie: "en-US" }), "fr-FR");
  assert.equal(page({ locale: "en", cookie: "de-DE" }), "de-DE");
  assert.equal(page({ locale: "fr", parameter: "en" }), "en-US");
  assert.equal(page({ locale: "fr", parameter: "EN-us" }), "en-US");
  assert.equal(page({ locale: "fr", parameter: "nl" }), "nl-BE");
  assert.equal(
    page({ locale: "fr", parameter: "de", cookie: "it-IT" }),
    "de-DE",
  );
  assert.equal(page({ locale: "en", parameter: "xx" }), "en-US");
  assert.equal(page({ locale: "en", parameter: ["fr"] }), "en-US");
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("a provider sign-in mark is read once", () => {
  const previous = globalThis.window;
  globalThis.window = { sessionStorage: memoryStorage() };
  try {
    assert.equal(takeOAuthSignInMark(), false);
    markOAuthSignIn();
    assert.equal(takeOAuthSignInMark(), true);
    assert.equal(takeOAuthSignInMark(), false);
  } finally {
    globalThis.window = previous;
  }
});

test("the verification return is single-use and limited to invitations", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  try {
    rememberVerificationReturn("/team/invite/token");
    assert.equal(takeVerificationReturn(), "/team/invite/token");
    assert.equal(takeVerificationReturn(), null);

    rememberVerificationReturn("/account");
    assert.equal(takeVerificationReturn(), null);

    rememberVerificationReturn("https://evil.test/team/invite/token");
    assert.equal(takeVerificationReturn(), null);

    localStorage.setItem(
      "privcloud_email_verification_return",
      JSON.stringify({ path: "/team/invite/token", expiresAt: Date.now() - 1 }),
    );
    assert.equal(takeVerificationReturn(), null);
  } finally {
    delete globalThis.localStorage;
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  }
});

test("every landing check gets the same remembered target", async () => {
  const previous = globalThis.window;
  globalThis.window = { sessionStorage: memoryStorage() };
  try {
    rememberPostAuthRedirectTarget("/team/invite/token");
    const results = await Promise.all([
      resolvePostAuthRedirectPath(undefined, null),
      resolvePostAuthRedirectPath(undefined, null),
    ]);
    assert.deepEqual(results, ["/team/invite/token", "/team/invite/token"]);
    assert.equal(
      await resolvePostAuthRedirectPath(undefined, null),
      "/team/invite/token",
    );
  } finally {
    globalThis.window = previous;
  }
});
