import {
  ColorScheme,
  ColorSchemeProvider,
  Container,
  MantineProvider,
  Stack,
} from "@mantine/core";
import { useColorScheme } from "@mantine/hooks";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
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
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import Header from "../components/header/Header";
import { ConfigContext } from "../hooks/config.hook";
import { UserContext } from "../hooks/user.hook";
import { LOCALES } from "../i18n/locales";
import authService from "../services/auth.service";
import configService from "../services/config.service";
import userService from "../services/user.service";
import GlobalStyle from "../styles/global.style";
import { buildTheme } from "../styles/mantine.style";
import Config from "../types/config.type";
import { CurrentUser } from "../types/user.type";
import i18nUtil from "../utils/i18n.util";
import userPreferences from "../utils/userPreferences.util";
import Footer from "../components/footer/Footer";
import CookieConsent from "../components/cookie/CookieConsent";
import { getUserKey, computeKeyHashFromEncoded } from "../utils/crypto.util";

const excludeDefaultLayoutRoutes = ["/admin/config/[category]"];

function App({ Component, pageProps }: AppProps) {
  // Use the cookie value for the initial render to avoid SSR hydration mismatch.
  // useColorScheme uses window.matchMedia which is not available on the server,
  // so the server always renders with the cookie value. We must match that on the client.
  const systemTheme = useColorScheme(pageProps.colorScheme);
  const router = useRouter();

  const [queryClient] = useState(() => new QueryClient());
  const [colorScheme, setColorScheme] = useState<ColorScheme>(
    pageProps.colorScheme ?? "dark",
  );

  const [user, setUser] = useState<CurrentUser | null>(pageProps.user);
  const [route, setRoute] = useState<string>(pageProps.route);

  const [configVariables, setConfigVariables] = useState<Config[]>(
    pageProps.configVariables,
  );

  useEffect(() => {
    setRoute(router.pathname);
  }, [router.pathname]);

  // Client-side session recovery: when SSR could not resolve the user
  // (e.g. reverse-proxy / WAF strips cookies), attempt a client-side
  // fetch so the browser sends its own cookie jar directly.
  // Only runs when a 'logged_in' marker cookie exists (proves a session
  // is active) but SSR failed to hydrate the user.
  useEffect(() => {
    if (user) return;
    if (!getCookie("logged_in")) return;
    authService
      .refreshAccessToken()
      .then(() => userService.getCurrentUser())
      .then((u) => {
        if (u) {
          setUser(u);
          // If the recovery happened on an auth page (e.g. PWA reopened
          // with an expired access_token), redirect to the account page
          // so the user does not stay stuck on the sign-in form.
          if (router.pathname === "/" || router.pathname.startsWith("/auth/")) {
            router.replace("/account");
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      authService.refreshAccessToken().catch(() => {});
    }, 10 * 1000); // 10 seconds -- cookie check is free (no network call)

    return () => clearInterval(interval);
  }, [user]);

  // Auto-refresh the E2E key hash on every authenticated page load.
  // This keeps the server-side hash in sync with the local key and
  // prevents verification mismatches on other browsers / devices.
  useEffect(() => {
    if (!user) return;
    const localKey = getUserKey();
    if (!localKey) return;
    computeKeyHashFromEncoded(localKey)
      .then((hash) => userService.setEncryptionKeyHash(hash))
      .catch(() => {
        // Non-critical -- key may be malformed in storage
      });
  }, [user]);

  // Register service worker for PWA
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch(() => {
          // Service worker registration failed -- non-critical
        });
    }

    // Manifest link is in _document.tsx <Head> for DevTools compatibility
  }, []);

  useEffect(() => {
    if (!pageProps.language) return;
    const cookieLanguage = getCookie("language");
    if (pageProps.language != cookieLanguage) {
      i18nUtil.setLanguageCookie(pageProps.language);
      if (cookieLanguage) location.reload();
    }
  }, []);

  useEffect(() => {
    const colorScheme =
      userPreferences.get("colorScheme") == "system"
        ? systemTheme
        : userPreferences.get("colorScheme");

    toggleColorScheme(colorScheme);
  }, [systemTheme]);

  const toggleColorScheme = (value: ColorScheme) => {
    setColorScheme(value ?? "dark");
    setCookie("mantine-color-scheme", value ?? "dark", {
      sameSite: "lax",
    });
  };

  const language = useRef(pageProps.language);
  setDayjsLocale(language.current);

  // fall back to english if key does not exist
  const i18nMessages = useMemo(
    () => ({
      ...i18nUtil.getLocaleByCode(LOCALES.ENGLISH.code)?.messages,
      ...i18nUtil.getLocaleByCode(language.current)?.messages,
    }),
    [language.current],
  );

  return (
    <>
      <Head>
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width"
        />
      </Head>
      <QueryClientProvider client={queryClient}>
        <HydrationBoundary state={pageProps.dehydratedState}>
          <IntlProvider
            messages={i18nMessages}
            locale={language.current}
            defaultLocale={LOCALES.ENGLISH.code}
          >
            <MantineProvider
              withGlobalStyles
              withNormalizeCSS
              theme={{
                colorScheme,
                ...buildTheme(
                  configVariables?.find(
                    (c) => c.key === "general.colorPalette",
                  )?.value ?? "victoria",
                ),
              }}
            >
              <ColorSchemeProvider
                colorScheme={colorScheme}
                toggleColorScheme={toggleColorScheme}
              >
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
                  <ModalsProvider>
                    <UserContext.Provider
                      value={{
                        user,
                        refreshUser: async () => {
                          const user = await userService.getCurrentUser();
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
                            sx={{ minHeight: "100vh" }}
                          >
                            <div>
                              <Header />
                              <main>
                                <Container>
                                  <Component {...pageProps} />
                                </Container>
                              </main>
                            </div>
                            <Footer />
                          </Stack>
                          <CookieConsent />
                        </>
                      )}
                    </UserContext.Provider>
                  </ModalsProvider>
                </ConfigContext.Provider>
              </ColorSchemeProvider>
            </MantineProvider>
          </IntlProvider>
        </HydrationBoundary>
        <ReactQueryDevtools initialIsOpen={false} />
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
    colorScheme: ColorScheme;
    language?: string;
  } = {
    route: ctx.resolvedUrl,
    colorScheme:
      (getCookie("mantine-color-scheme", ctx) as ColorScheme) ?? "dark",
  };

  if (ctx.req) {
    const apiURL = process.env.API_URL || "http://127.0.0.1:8080";
    const cookieHeader = ctx.req.headers.cookie;

    pageProps.user = await axios(`${apiURL}/api/users/me`, {
      headers: { cookie: cookieHeader },
    })
      .then((res) => res.data)
      .catch(() => null);

    pageProps.configVariables = (await axios(`${apiURL}/api/configs`)).data;

    pageProps.route = ctx.req.url;

    const requestLanguage = i18nUtil.getLanguageFromAcceptHeader(
      ctx.req.headers["accept-language"],
    );

    pageProps.language = ctx.req.cookies["language"] ?? requestLanguage;
  }
  return { pageProps };
};

export default App;
