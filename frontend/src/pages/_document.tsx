import { ColorSchemeScript } from "@mantine/core";
import { createGetInitialProps } from "@mantine/emotion";
import createEmotionServer from "@emotion/server/create-instance";
import Document, { Head, Html, Main, NextScript, DocumentContext } from "next/document";
import emotionCache from "../utils/emotionCache";
import { __ssrI18nMessages } from "./_app";

const emotionServer = createEmotionServer(emotionCache);
const emotionGetInitialProps = createGetInitialProps(Document, emotionServer);

export default class _Document extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    const initialProps = await emotionGetInitialProps(ctx);

    // Extract resolved language from cookie (set by _app SSR) or Accept-Language
    let lang = "fr";
    // Extract resolved color scheme from cookie -- mirrors _app.getInitialProps
    // so the SSR HTML carries data-mantine-color-scheme without requiring the
    // ColorSchemeScript to execute. Crawlers / SEO scanners that don't run JS
    // (SortSite, etc.) would otherwise compute styles against a "no scheme"
    // body and incorrectly flag dark-mode text (white) as white-on-white.
    let colorScheme: "dark" | "light" = "dark";
    if (ctx.req) {
      const cookieHeader = ctx.req.headers.cookie ?? "";
      const langMatch = cookieHeader.match(/language=([^;]+)/);
      if (langMatch) {
        lang = langMatch[1].split("-")[0];
      } else {
        lang = ctx.locale ?? "fr";
      }
      const csMatch = cookieHeader.match(/mantine-color-scheme=([^;]+)/);
      if (csMatch) {
        const v = decodeURIComponent(csMatch[1]);
        if (v === "light" || v === "dark") colorScheme = v;
        // "auto" falls through to the "dark" default; the client-side
        // ColorSchemeScript / MantineProvider will reconcile to the system
        // preference on hydration.
      }
    }

    return { ...initialProps, lang, colorScheme };
  }

  render() {
    const lang = (this.props as any).lang ?? "fr";
    const colorScheme = (this.props as any).colorScheme ?? "dark";

    return (
      <Html
        lang={lang}
        data-mantine-color-scheme={colorScheme}
        suppressHydrationWarning
      >
        <Head>
          <meta charSet="utf-8" />
          <ColorSchemeScript defaultColorScheme="dark" />
          <link rel="preconnect" href="/" />
          <link rel="dns-prefetch" href="/" />
          <link rel="icon" type="image/x-icon" href="/img/favicon.ico" />
          <link rel="apple-touch-icon" href="/img/icons/icon-128x128.png" />
          <link rel="manifest" href="/manifest.json" />

          <link
            rel="preload"
            href="/img/logo.webp"
            as="image"
            type="image/webp"
          />

          <meta name="theme-color" content="#141517" />
        </Head>
        <body>
          {/* Inject i18n messages as a separate inline script so they're
              available synchronously for React hydration WITHOUT being
              serialized into __NEXT_DATA__ (saves ~120 kB in pageProps). */}
          <script
            id="__I18N__"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: __ssrI18nMessages
                ? `self.__I18N__=JSON.parse(${JSON.stringify(JSON.stringify(__ssrI18nMessages)).replace(/</g, "\\u003c")})`
                : "",
            }}
          />
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
