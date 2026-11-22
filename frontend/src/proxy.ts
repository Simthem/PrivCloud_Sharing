import type { SiteConfigRow as ConfigRow } from "./utils/siteIndexing.server";
import {
  readSiteConfig,
  siteIndexingResponse,
} from "./utils/siteIndexing.server";
import { jwtDecode } from "jwt-decode";
import { NextRequest, NextResponse } from "next/server";
import {
  buildSignInRedirectPath,
  isEmailVerificationRoutePath,
  isProtectedTeamContextPath,
  isTeamInvitationRoutePath,
  isChosenLanguage,
  LANGUAGE_CHOICE_COOKIE,
  redirectLocale,
} from "./utils/authRedirect.util";

// This middleware redirects based on different conditions:
// - Authentication state
// - Setup status
// - Admin privileges

export const config = {
  matcher: ["/", "/((?!api(?:/|$)|_next/static/).*)"],
};

export async function proxy(request: NextRequest) {
  const { rows, blockIndexing } = await readSiteConfig();
  const path = request.nextUrl.pathname;
  // Locale roots and files are matched for indexing only.
  const isPage =
    (path !== "/" && !/^\/(?:api|static|_next)|\./.test(path)) ||
    /^\/(?:share|s|sign|team\/invite|external\/invite)(?:\/|$)/.test(path);
  const response = isPage ? await routePage(request, rows) : undefined;
  return blockIndexing ? siteIndexingResponse(request, response) : response;
}

async function routePage(request: NextRequest, configData: ConfigRow[]) {
  const routes = {
    unauthenticated: new Routes(["/auth/*", "/"]),
    public: new Routes([
      "/share/*",
      "/s/*",
      "/sign/*",
      "/upload/*",
      "/maintenance",
      "/error",
      "/imprint",
      "/privacy",
      "/integrations",
    ]),
    admin: new Routes(["/admin", "/admin/*"]),
    account: new Routes(["/account*"]),
    disabled: new Routes([]),
  };

  const getConfig = <T = string>(key: string): T | null => {
    if (!configData) return null;
    const cfg = (configData as ConfigRow[]).find((v) => v.key === key);
    if (!cfg) return null;
    const value = cfg.value ?? cfg.defaultValue;
    if (cfg.type === "number" || cfg.type === "filesize")
      return parseInt(value as string) as T;
    if (cfg.type === "boolean") return (value === "true") as T;
    return value as T;
  };

  const route = request.nextUrl.pathname;
  const hasImprintText = !!(
    getConfig("legal.imprintTextFr") ||
    getConfig("legal.imprintTextEn") ||
    getConfig("legal.imprintText")
  );
  const hasPrivacyText = !!(
    getConfig("legal.privacyPolicyTextFr") ||
    getConfig("legal.privacyPolicyTextEn") ||
    getConfig("legal.privacyPolicyText")
  );

  // SEO locale routing: cookie-based redirect to the correct URL locale.
  // First-time visitors (no cookie) and non-fr/en users stay on the
  // requested URL locale - only explicit fr/en cookie triggers a redirect.
  const cookieLang = request.cookies.get("language")?.value;
  const locale = redirectLocale({
    locale: request.nextUrl.locale,
    pathname: route,
    parameter: request.nextUrl.searchParams.get("lang"),
    cookie: cookieLang,
    chosen: isChosenLanguage(
      cookieLang,
      request.cookies.get(LANGUAGE_CHOICE_COOKIE)?.value,
    ),
    acceptLanguage: request.headers.get("accept-language"),
  });
  if (locale) {
    const url = request.nextUrl.clone();
    url.locale = locale;
    return NextResponse.redirect(url);
  }

  let user: { isAdmin: boolean; email: string } | null = null;
  const accessToken = request.cookies.get("access_token")?.value;
  const hasActiveSession = !!request.cookies.get("logged_in")?.value;

  try {
    const claims = jwtDecode<{ exp: number; isAdmin: boolean; email: string }>(
      accessToken as string,
    );
    if (claims.exp * 1000 > Date.now()) {
      user = claims;
    }
  } catch {
    user = null;
  }

  // Team pages and Team-scoped uploads are never public, even when ordinary
  // anonymous uploads are enabled. Run this before maintenance/public routing
  // so authentication is always the first decision for this context.
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (
    isProtectedTeamContextPath(requestedPath) &&
    !isTeamInvitationRoutePath(route) &&
    !user &&
    !hasActiveSession
  ) {
    const signInPath = buildSignInRedirectPath(requestedPath);
    const url = request.nextUrl.clone();
    const qIdx = signInPath.indexOf("?");
    url.pathname = signInPath.substring(0, qIdx);
    url.search = signInPath.substring(qIdx);
    return NextResponse.redirect(url);
  }

  // Maintenance mode: redirect upload pages to /maintenance
  // unless the user is admin or their email is in the allowed list.
  const maintenanceMode = getConfig("general.maintenanceMode");
  if (maintenanceMode) {
    const uploadRoutes = new Routes(["/upload", "/upload/*"]);
    const isUploadRoute = uploadRoutes.contains(route);

    if (isUploadRoute && !user?.isAdmin) {
      const allowedEmailsRaw: string =
        getConfig("general.maintenanceAllowedEmails") || "";

      if (!isEmailAllowed(user?.email || "", allowedEmailsRaw)) {
        return NextResponse.redirect(new URL("/maintenance", request.url));
      }
    }

    // If not in maintenance mode but user navigates to /maintenance, redirect away
  } else if (route === "/maintenance") {
    return NextResponse.redirect(new URL("/upload", request.url));
  }

  if (!getConfig("share.allowRegistration")) {
    routes.disabled.routes.push("/auth/signUp");
  }

  if (getConfig("share.allowUnauthenticatedShares")) {
    routes.public.routes = ["*"];
  }

  if (!getConfig("smtp.enabled")) {
    routes.disabled.routes.push("/auth/resetPassword*");
  }

  if (!getConfig("legal.enabled")) {
    routes.disabled.routes.push("/imprint", "/privacy");
  } else {
    if (!getConfig("legal.imprintText") && !getConfig("legal.imprintUrl")) {
      routes.disabled.routes.push("/imprint");
    }
    if (
      !getConfig("legal.privacyPolicyText") &&
      !getConfig("legal.privacyPolicyUrl")
    ) {
      routes.disabled.routes.push("/privacy");
    }
  }

  // prettier-ignore
  const rules = [
    // Disabled routes
    {
      condition: routes.disabled.contains(route),
      path: "/",
    },
     // Authenticated state
    {
      condition: user && routes.unauthenticated.contains(route) && !isEmailVerificationRoutePath(route) && route !== "/auth/change-email" && !getConfig("share.allowUnauthenticatedShares"),
      path: "/upload",
    },
    // Unauthenticated state -- only redirect when the session is fully
    // dead (!hasActiveSession).  When the logged_in cookie is still
    // present the refresh token may still be valid: let the page load
    // so the client-side interceptor can refresh the access token
    // without bouncing through /auth/signIn.
    {
      condition: !user && !hasActiveSession && !routes.public.contains(route) && !routes.unauthenticated.contains(route),
      path: "/auth/signIn",
    },
    // Admin privileges
    {
      // A known non-administrator is sent away, an expired session refreshes first.
      condition: routes.admin.contains(route) && (user ? !user.isAdmin : !hasActiveSession),
      path: "/upload",
    },
    // Home page - also redirect when the session is still alive
    // (logged_in cookie present) to avoid a flash of the public homepage
    // while the client-side refreshes an expired access token.
    {
      condition: (!getConfig("general.showHomePage") || user || hasActiveSession) && route == "/",
      path: "/upload",
    },
    // Imprint redirect
    {
      condition: route == "/imprint" && !hasImprintText && getConfig("legal.imprintUrl"),
      path: getConfig("legal.imprintUrl"),
    },
    // Privacy redirect
    {
      condition: route == "/privacy" && !hasPrivacyText && getConfig("legal.privacyPolicyUrl"),
      path: getConfig("legal.privacyPolicyUrl"),
    },
  ];
  for (const rule of rules) {
    if (rule.condition) {
      let { path } = rule;

      if (path == "/auth/signIn") {
        path = path + "?redirect=" + encodeURIComponent(route);
      }
      return NextResponse.redirect(new URL(path as string, request.url));
    }
  }

  if (new Routes(["/sign/*"]).contains(route)) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
}

// Helper class to check if a route matches a list of routes
class Routes {
  // eslint-disable-next-line no-unused-vars
  constructor(public routes: string[]) {}

  contains(_route: string) {
    for (const route of this.routes) {
      if (new RegExp("^" + route.replace(/\*/g, ".*") + "$").test(_route))
        return true;
    }
    return false;
  }
}

// Check if a user email is in the allowed list.
// Each entry is separated by newlines or commas.
function isEmailAllowed(userEmail: string, allowedEmailsRaw: string): boolean {
  if (!userEmail || !allowedEmailsRaw.trim()) return false;

  const entries = allowedEmailsRaw
    .split(/[\n,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return entries.includes(userEmail.toLowerCase());
}
