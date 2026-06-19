import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "altcha/altcha.css";

import {
  Container,
  CSSVariablesResolver,
  MantineColorScheme,
  MantineProvider,
  Stack,
} from "@mantine/core";
import { useColorScheme } from "@mantine/hooks";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { emotionTransform, MantineEmotionProvider } from "@mantine/emotion";
import emotionCache from "../utils/emotionCache";
import axios from "axios";
import { getCookie, setCookie } from "cookies-next";
import { setDayjsLocale } from "../utils/dayjs";
import { GetServerSidePropsContext } from "next";
import type { AppProps } from "next/app";
import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";
import { IntlProvider } from "react-intl";
import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import dynamic from "next/dynamic";

const ReactQueryDevtools = dynamic(
  () =>
    import("@tanstack/react-query-devtools").then((mod) => ({
      default: mod.ReactQueryDevtools,
    })),
  { ssr: false },
);
import Header from "../components/header/Header";
import { HEADER_HEIGHT } from "../components/header/Header.styles";
import { ConfigContext } from "../hooks/config.hook";
import { UserContext } from "../hooks/user.hook";
import {
  LOCALES,
  englishMessages,
  loadLocaleMessages,
  setActiveMessages,
} from "../i18n/locales";
import authService from "../services/auth.service";
import { isUploadActive } from "../services/api.service";
import configService from "../services/config.service";
import userService from "../services/user.service";
import GlobalStyle from "../styles/global.style";
import { buildTheme } from "../styles/mantine.style";
import Config from "../types/config.type";
import { CurrentUser } from "../types/user.type";
import i18nUtil from "../utils/i18n.util";
import { resolvePostAuthRedirectPath } from "../utils/router.util";
import userPreferences from "../utils/userPreferences.util";

// Module-level store for SSR i18n messages.
// _app.getInitialProps loads messages here; _document.tsx reads them to emit
// an inline <script> (avoids serializing ~120 kB into __NEXT_DATA__).
// Safe: Next.js SSR pipeline is single-threaded per request.
export let __ssrI18nMessages: Record<string, string> | null = null;
const Footer = dynamic(() => import("../components/footer/Footer"), {
  ssr: false,
});
const CookieConsent = dynamic(
  () => import("../components/cookie/CookieConsent"),
  { ssr: false },
);
const E2EKeyPrompt = dynamic(
  () => import("../components/auth/E2EKeyPrompt"),
  { ssr: false },
);
const TeamStatusChecker = dynamic(
  () => import("../components/team/TeamStatusChecker"),
  { ssr: false },
);

// WCAG AA: override --mantine-color-dimmed for sufficient contrast on
// both light (gray-7 = #495057, 7.5:1 on white) and dark (dark-1 = #A6A7AB, 8.5:1) backgrounds.
const contrastResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { "--mantine-color-dimmed": "var(--mantine-color-gray-7)" },
  dark: { "--mantine-color-dimmed": "var(--mantine-color-dark-1)" },
});

const excludeDefaultLayoutRoutes = ["/admin/config/[category]"];

function App({ Component, pageProps }: AppProps) {
  // Use the cookie value for the initial render to avoid SSR hydration mismatch.
  // useColorScheme uses window.matchMedia which is not available on the server,
  // so the server always renders with the cookie value. We must match that on the client.
  const systemTheme = useColorScheme(pageProps.colorScheme);
  const router = useRouter();

  const [queryClient] = useState(() => new QueryClient());
  const [colorScheme, setColorScheme] = useState<MantineColorScheme>(
    pageProps.colorScheme ?? "dark",
  );

  const [user, setUser] = useState<CurrentUser | null>(pageProps.user);
  const route = router.pathname;

  const [configVariables, setConfigVariables] = useState<Config[]>(
    pageProps.configVariables,
  );

  // E2E key prompt: shown when user has a server-side key hash but the
  // in-memory key is empty (RAM-only model -- key lost on tab close).
  const [showE2EPrompt, setShowE2EPrompt] = useState(false);
  const e2ePromptShownRef = useRef(false);

  // Onboarding tour: shown once on first sign-in, gated by localStorage.
  const mainOffset = route === "/" ? HEADER_HEIGHT : HEADER_HEIGHT + 40;



  // Attempt to recover/ maintain the session client-side.  This single
  // function covers both the "cold start" scenario (SSR didn't hydrate
  // the user) and the "warm" scenario (access_token just expired while
  // the page was open or the iframe was in the background).
  const recoverSession = async () => {
    if (!(await authService.hasActiveSession())) return;
    try {
      await authService.refreshAccessToken();
      const u = await userService.getCurrentUser({ refresh: false });
      if (u) {
        setUser(u);
        if (router.pathname === "/" || router.pathname.startsWith("/auth/")) {
          const target = await resolvePostAuthRedirectPath(undefined, u);
          router.replace(target);
        }
      }
    } catch {
      // Refresh token is dead -- clear the stale React state so the
      // UI reflects reality.  The 401 interceptor will redirect to
      // sign-in on the next API call.
      setUser(null);
    }
  };

  // SafeLine challenge popup signal: if THIS window was opened as a popup
  // by completeSafeLineChallenge() (api.service.ts) to resolve a WAF 468
  // challenge, notify the main tab that the app loaded successfully.
  //
  // Detection: two methods -
  //   1. sessionStorage.__sl_challenge = '1' (set by challenge-proxy.html)
  //   2. window.opener exists (direct popup to '/')
  // If either is true, this is a challenge popup.
  //
  // Communication: both BroadcastChannel AND postMessage are used for
  // maximum compatibility.  BroadcastChannel works even when opener is
  // null (noopener windows); postMessage works on older browsers.
  useEffect(() => {
    const isChallengeWindow =
      sessionStorage.getItem("__sl_challenge") === "1" || !!window.opener;

    if (!isChallengeWindow) return;

    // Clean up the proxy flag if present
    sessionStorage.removeItem("__sl_challenge");

    // Broadcast via BroadcastChannel
    try {
      const bc = new BroadcastChannel("safeline-challenge");
      bc.postMessage({ type: "safeline-challenge-complete" });
      setTimeout(() => bc.close(), 2000);
    } catch {
      // BroadcastChannel not available - rely on postMessage below
    }

    // postMessage to opener
    if (window.opener) {
      try {
        window.opener.postMessage(
          { type: "safeline-challenge-complete" },
          window.location.origin,
        );
      } catch {
        // opener on a different origin or already GC'd -- ignore
      }
    }
    // Note: no auto-close here - the main tab closes the popup via
    // popup.close() inside cleanup() when completeSafeLineChallenge()
    // resolves.  Auto-closing too early (e.g. 3s) would close the popup
    // before SafeLine has shown its real challenge page.
  }, []);

  // Cold-start recovery: SSR could not resolve the user (e.g. the
  // access_token cookie expired between SSR and hydration, or a
  // reverse-proxy / WAF stripped the cookies).
  useEffect(() => {
    if (!user) recoverSession();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Visibility recovery: when the user switches back to this tab /
  // iframe, refresh the session immediately instead of waiting for the
  // next timer tick.  Browsers throttle setInterval in background
  // tabs / hidden iframes, so the periodic refresh might not have
  // fired for a long time.  On mobile the tab can be suspended for
  // hours -- the access_token (13 min) will be expired on wake-up.
  // Refreshing proactively here avoids a 401 race on the first API
  // call the user triggers after returning to the app.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      if (isUploadActive()) return;

      if (!user) {
        recoverSession();
        return;
      }

      // User still set but access_token likely expired after sleep.
      // Proactively refresh so the next API call won't 401.
      try {
        await authService.refreshAccessToken();
      } catch {
        // refresh_token dead -- let the interval handle cleanup
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic session maintenance.  Covers two scenarios:
  //
  // 1. user IS set (normal case): refresh the access_token cookie
  //    before it expires.  If the refresh fails twice in a row the
  //    session is dead -- clear the user and let the next navigation
  //    or visibility-change trigger a recovery attempt.
  //
  // 2. user is NULL after SSR: retry occasionally only when the backend
  //    still sees a refresh-token session.
  useEffect(() => {
    let consecutiveFailures = 0;

    const interval = setInterval(async () => {
      // Skip token refresh entirely during uploads -- the upload loop
      // handles its own auth via manual fetch("/api/auth/token") on 401.
      // Attempting a refresh here can trigger a SafeLine 468 challenge
      // that crashes the page (iframe top-navigation or reload).
      if (isUploadActive()) return;

      if (!user) {
        if (!(await authService.hasActiveSession())) return;
        // Recovery path -- try to restore React user state.
        await recoverSession();
        return;
      }

      // Normal maintenance path.
      try {
        await authService.refreshAccessToken();
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures++;
        // Don't invalidate the user state while an upload is in
        // progress -- the upload retry logic handles transient auth
        // issues, and clearing the user mid-upload would break the UI.
        if (consecutiveFailures >= 5 && !isUploadActive()) {
          setUser(null);
        }
      }
    }, 60 * 1000); // 60 seconds -- access_token lives 13 min, no need to poll faster

    return () => clearInterval(interval);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Validate the tab-scoped E2E key before trusting it. A stale key can remain
  // in sessionStorage if another account signs in from the same browser tab.
  useEffect(() => {
    if (!user) return;

    import("../utils/crypto.util").then(
      ({
        getUserKey,
        computeKeyHashFromEncoded,
        computeKeyHashFromEncodedLegacy,
        loadKeyWithPasskey,
        hasPasskeyWrappedKey,
        storeUserKey,
        removeUserKey,
      }) => {
        const showPrompt = () => {
          if (e2ePromptShownRef.current) return;
          e2ePromptShownRef.current = true;
          setShowE2EPrompt(true);
        };

        const verifyAndMigrateKey = async (encodedKey: string) => {
          const hash = await computeKeyHashFromEncoded(encodedKey, user.id);
          let valid = await userService.verifyEncryptionKey(hash);
          if (!valid) {
            const legacyHash = await computeKeyHashFromEncodedLegacy(
              encodedKey,
            );
            valid = await userService.verifyEncryptionKey(legacyHash);
            if (valid) {
              await userService.setEncryptionKeyHash(hash);
            }
          }
          return valid;
        };

        const localKey = getUserKey();
        if (!localKey) {
          // User has a server-side key but nothing in RAM -> try passkey auto-recovery
          if (user.hasEncryptionKey) {
            // Fetch server-side wrapped keys, then try local + server credentials
            userService
              .listWrappedKeys()
              .then((serverKeys) => {
                if (!hasPasskeyWrappedKey() && serverKeys.length === 0) {
                  // No passkey data anywhere -> show manual prompt
                  showPrompt();
                  return;
                }
                loadKeyWithPasskey(serverKeys)
                  .then(async (encodedKey) => {
                    if (encodedKey) {
                      // Verify key matches server-side hash before trusting it
                      const valid = await verifyAndMigrateKey(encodedKey);
                      if (valid) {
                        storeUserKey(encodedKey);
                        return; // Key restored silently, no prompt needed
                      }
                    }
                    // Passkey recovery failed or key mismatch -> show manual prompt
                    showPrompt();
                  })
                  .catch(showPrompt);
              })
              .catch(() => {
                // Server unreachable -> try local only
                if (hasPasskeyWrappedKey()) {
                  loadKeyWithPasskey()
                    .then(async (encodedKey) => {
                      if (encodedKey) {
                        const valid = await verifyAndMigrateKey(encodedKey);
                        if (valid) {
                          storeUserKey(encodedKey);
                          return;
                        }
                      }
                      showPrompt();
                    })
                    .catch(showPrompt);
                } else {
                  showPrompt();
                }
              });
          } else if (user.hasTeamMembership) {
            // Team member without any encryption key yet -> prompt to set up E2E
            showPrompt();
          }
          return;
        }

        if (!user.hasEncryptionKey) {
          removeUserKey();
          if (user.hasTeamMembership) showPrompt();
          return;
        }

        verifyAndMigrateKey(localKey)
          .then((valid) => {
            if (!valid) {
              removeUserKey();
              showPrompt();
              throw new Error("stale_e2e_session_key");
            }
          })
          .catch(() => {
            // Non-critical -- key may be malformed in storage or server unreachable.
          });
      },
    );
  }, [user]);

  // iOS fix: prevent auto-zoom on input focus without disabling user zoom.
  // On iPhone/iPad, Safari zooms in whenever a form field receives focus if
  // the font-size is below 16 px.  Setting maximum-scale=1 during focus
  // suppresses that zoom while still letting the user pinch-zoom freely
  // (the restriction is lifted again on blur).
  useEffect(() => {
    const isIOS =
      /iPad|iPhone/.test(navigator.userAgent) && !(window as any).MSStream;
    if (!isIOS) return;

    const viewport = document.querySelector<HTMLMetaElement>(
      "[name=viewport]",
    );
    if (!viewport) return;

    const originalContent = viewport.getAttribute("content") ?? "";

    const onFocusIn = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        viewport.setAttribute(
          "content",
          originalContent.replace(/,?\s*maximum-scale=[^,]*/i, "") +
            ", maximum-scale=1",
        );
      }
    };

    const onFocusOut = () => {
      viewport.setAttribute("content", originalContent);
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Register service worker for PWA -- deferred after page load to avoid
  // competing with hydration for main-thread time.
  useEffect(() => {
    const register = () => {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);

  useEffect(() => {
    if (!pageProps.language) return;
    const cookieLanguage = getCookie("language");
    if (pageProps.language != cookieLanguage) {
      i18nUtil.setLanguageCookie(pageProps.language);
      if (cookieLanguage) location.reload();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const colorScheme =
      userPreferences.get("colorScheme") == "system"
        ? systemTheme
        : userPreferences.get("colorScheme");

    toggleColorScheme(colorScheme);
  }, [systemTheme]);

  useEffect(() => {
    const onThemeChange = () => {
      const pref = userPreferences.get("colorScheme");
      const resolved = pref === "system" ? systemTheme : pref;
      toggleColorScheme(resolved);
    };
    window.addEventListener("theme-change", onThemeChange);
    return () => window.removeEventListener("theme-change", onThemeChange);
  }, [systemTheme]);

  const toggleColorScheme = (value: MantineColorScheme) => {
    setColorScheme(value ?? "dark");
    setCookie("mantine-color-scheme", value ?? "dark", {
      sameSite: "lax",
    });
  };

  const language = useRef(pageProps.language);
  setDayjsLocale(language.current);

  // Messages are NOT in pageProps (to keep __NEXT_DATA__ small).
  // Server: read from the module-level variable set in getInitialProps.
  // Client: read from window.__I18N__ (injected by _document.tsx).
  const i18nMessagesRef = useRef<Record<string, string>>(
    typeof window !== "undefined"
      ? (window as any).__I18N__ ?? englishMessages
      : __ssrI18nMessages ?? englishMessages,
  );
  const i18nMessages = useMemo(
    () => ({ ...englishMessages, ...i18nMessagesRef.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language.current],
  );
  setActiveMessages(i18nMessages);

  const palette =
    configVariables?.find((c) => c.key === "general.colorPalette")?.value ??
    "victoria";
  const mantineTheme = useMemo(
    () => buildTheme(palette, colorScheme),
    [colorScheme, palette],
  );

  return (
    <>
      <Head>
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width"
        />
        {/* Prevent iOS Safari auto-zoom on input focus.
            Safari zooms when a focused input has font-size < 16px.
            maximum-scale in viewport meta is ignored since iOS 10.
            This CSS override is the only reliable method. */}
        <style>{`
          @supports (-webkit-touch-callout: none) {
            input, textarea, select, .mantine-Input-input {
              font-size: 16px !important;
            }
          }
        `}</style>
      </Head>
      <QueryClientProvider client={queryClient}>
        <HydrationBoundary state={pageProps.dehydratedState}>
          <IntlProvider
            messages={i18nMessages}
            locale={language.current}
            defaultLocale={LOCALES.ENGLISH.code}
          >
            <MantineProvider
              theme={mantineTheme}
              forceColorScheme={colorScheme === "auto" ? undefined : colorScheme}
              defaultColorScheme="dark"
              stylesTransform={emotionTransform}
              cssVariablesResolver={contrastResolver}
            >
              <MantineEmotionProvider cache={emotionCache}>
                <GlobalStyle />
                <Notifications />
                <ConfigContext.Provider
                  value={{
                    configVariables,
                    refresh: async () => {
                      setConfigVariables(await configService.list());
                    },
                  }}
                >
                  <ModalsProvider modalProps={{ lockScroll: false }}>
                    <UserContext.Provider
                      value={{
                        user,
                        refreshUser: async (options) => {
                          const user = await userService.getCurrentUser(
                            options,
                          );
                          setUser(user);
                          return user;
                        },
                      }}
                    >
                      {excludeDefaultLayoutRoutes.includes(route) ? (
                        <Component {...pageProps} />
                      ) : (
                        <>
                          <Stack
                            justify="space-between"
                            style={{ minHeight: "100vh" }}
                          >
                            <div>
                              <Header />
                              <main style={{ paddingTop: mainOffset }}>
                                <Container
                                  fluid={route === "/"}
                                  px={route === "/" ? 0 : undefined}
                                  style={route === "/" ? { overflowX: "hidden" } : undefined}
                                >
                                  <Component {...pageProps} />
                                </Container>
                              </main>
                            </div>
                            <Footer />
                          </Stack>
                          <CookieConsent />
                          <E2EKeyPrompt
                            opened={showE2EPrompt}
                            onClose={() => setShowE2EPrompt(false)}
                            userId={user?.id ?? ""}
                          />
                          {user && <TeamStatusChecker />}
                        </>
                      )}
                    </UserContext.Provider>
                  </ModalsProvider>
                </ConfigContext.Provider>
              </MantineEmotionProvider>
            </MantineProvider>
          </IntlProvider>
        </HydrationBoundary>
        {process.env.NODE_ENV === "development" && (
          <ReactQueryDevtools initialIsOpen={false} />
        )}
      </QueryClientProvider>
    </>
  );
}

// Fetch user and config variables on server side when the first request is made
// These will get passed as a page prop to the App component and stored in the contexts
App.getInitialProps = async ({ ctx }: { ctx: GetServerSidePropsContext }) => {
  let pageProps: {
    user?: CurrentUser;
    configVariables?: Config[];
    route?: string;
    colorScheme: MantineColorScheme;
    language?: string;
  } = {
    route: ctx.resolvedUrl,
    colorScheme:
      (getCookie("mantine-color-scheme", ctx) as MantineColorScheme) ?? "dark",
  };

  if (ctx.req) {
    const apiURL = process.env.API_URL || "http://127.0.0.1:8080";
    const cookieHeader = ctx.req.headers.cookie;
    const hasSession = cookieHeader?.includes("logged_in=");

    // Only fetch user when a session cookie exists -- anonymous visitors
    // (e.g. homepage) skip this entirely, saving ~100-200ms TTFB.
    const userPromise = hasSession
      ? axios(`${apiURL}/api/users/me`, {
          headers: { cookie: cookieHeader },
        })
          .then((res) => res.data)
          .catch(() => null)
      : Promise.resolve(null);

    const configPromise = axios(`${apiURL}/api/configs`)
      .then((res) => res.data)
      .catch(() => []);

    const [userData, configData] = await Promise.all([
      userPromise,
      configPromise,
    ]);

    pageProps.user = userData;
    pageProps.configVariables = configData;

    // SSR token refresh: when the access_token cookie has expired but
    // the refresh_token is still valid, ask the backend to issue a new
    // access_token and retry the user fetch.  This avoids the flash of
    // "logged-out" UI that otherwise happens on every full page load
    // after 13 min of inactivity.
    if (!pageProps.user && cookieHeader?.includes("refresh_token=")) {
      try {
        const refreshRes = await axios.post(
          `${apiURL}/api/auth/token`,
          {},
          { headers: { cookie: cookieHeader } },
        );
        // Forward the Set-Cookie from the refresh response to the
        // browser so the new access_token cookie is stored.
        const setCookieHeaders = refreshRes.headers["set-cookie"];
        if (setCookieHeaders && ctx.res) {
          ctx.res.setHeader("Set-Cookie", setCookieHeaders);
        }
        // Extract the fresh access_token from the Set-Cookie to use
        // it in the retry call (the cookie jar on the server is not
        // automatically updated).
        const freshCookie = setCookieHeaders
          ?.find((c: string) => c.startsWith("access_token="));
        if (freshCookie) {
          const token = freshCookie.split(";")[0]; // "access_token=xxx"
          pageProps.user = await axios(`${apiURL}/api/users/me`, {
            headers: { cookie: `${cookieHeader}; ${token}` },
          })
            .then((res) => res.data)
            .catch(() => null);
        }
      } catch {
        // Refresh token also expired -- nothing to do, client-side
        // recovery will handle it.
      }
    }

    pageProps.route = ctx.req.url;

    // URL locale from Next.js i18n routing ('fr' or 'en')
    pageProps.language = ctx.req.cookies["language"]
      ?? (ctx.locale === "en" ? "en-US" : "fr-FR");

    // Load i18n messages for SSR rendering but do NOT include them in
    // pageProps (which is serialized into __NEXT_DATA__, adding ~120 kB
    // to every page).  Instead, store them in a module-level variable
    // that the component reads during SSR, and _document.tsx emits as a
    // separate inline <script> for client hydration.
    const isDataRequest = ctx.req.headers["x-nextjs-data"] !== undefined;
    if (!isDataRequest) {
      __ssrI18nMessages = await loadLocaleMessages(pageProps.language);
    }
  }
  return { pageProps };
};

export default App;
