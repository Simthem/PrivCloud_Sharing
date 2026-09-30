import { ColorSchemeScript } from "@mantine/core";
import { createGetInitialProps } from "@mantine/emotion";
import createEmotionServer from "@emotion/server/create-instance";
import { randomBytes } from "node:crypto";
import Document, {
  Head,
  Html,
  Main,
  NextScript,
  DocumentContext,
} from "next/document";
import {
  cloneElement,
  isValidElement,
  type ComponentType,
  type ReactElement,
} from "react";
import {
  buildContentSecurityPolicy,
  shouldEmbedCspMeta,
} from "../utils/csp.util";
import { createEmotionCache } from "../utils/emotionCache";
import { __ssrI18nMessages } from "./_app";

type PrivCloudDocumentProps = {
  lang?: string;
  colorScheme?: "dark" | "light";
  nonce?: string;
  contentSecurityPolicy?: string;
};

export default class _Document extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    const nonce = randomBytes(18).toString("base64url");
    const requestEmotionCache = createEmotionCache(nonce);
    const emotionServer = createEmotionServer(requestEmotionCache);
    const emotionGetInitialProps = createGetInitialProps(
      Document,
      emotionServer,
    );
    const originalRenderPage = ctx.renderPage;

    ctx.renderPage = () =>
      originalRenderPage({
        enhanceApp: (App) => {
          const AppWithNonce = App as unknown as ComponentType<
            Record<string, unknown>
          >;
          function NoncedApp(props: Record<string, unknown>) {
            return (
              <AppWithNonce
                {...props}
                emotionCache={requestEmotionCache}
                cspNonce={nonce}
              />
            );
          }
          return NoncedApp;
        },
      });

    const initialProps = await emotionGetInitialProps(ctx);
    const initialHead = (initialProps as { head?: ReactElement[] }).head;
    const noncedHead = initialHead?.map((element) =>
      isValidElement<{ nonce?: string }>(element) &&
      (element.type === "script" || element.type === "style")
        ? cloneElement(element, { nonce })
        : element,
    );

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

    const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
    // Next exposes a synthetic response while exporting static HTML. It cannot
    // preserve response headers, so Capacitor must receive a meta policy.
    const useMetaCsp = shouldEmbedCspMeta(Boolean(ctx.res));
    if (!useMetaCsp) {
      ctx.res?.setHeader("Content-Security-Policy", contentSecurityPolicy);
      ctx.res?.setHeader("Cache-Control", "private, no-store, max-age=0");
    }

    return {
      ...initialProps,
      ...(noncedHead ? { head: noncedHead } : {}),
      lang,
      colorScheme,
      nonce,
      contentSecurityPolicy: useMetaCsp ? contentSecurityPolicy : undefined,
    };
  }

  render() {
    const props = this.props as PrivCloudDocumentProps;
    const lang = props.lang ?? "fr";
    const colorScheme = props.colorScheme ?? "dark";
    const nonce = props.nonce;

    return (
      <Html
        lang={lang}
        data-mantine-color-scheme={colorScheme}
        suppressHydrationWarning
      >
        <Head nonce={nonce}>
          {props.contentSecurityPolicy && (
            <meta
              httpEquiv="Content-Security-Policy"
              content={props.contentSecurityPolicy}
            />
          )}
          {nonce && <meta name="csp-nonce" content={nonce} />}
          <meta charSet="utf-8" />
          <ColorSchemeScript defaultColorScheme="dark" nonce={nonce} />
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
            nonce={nonce}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: __ssrI18nMessages
                ? `self.__I18N__=JSON.parse(${JSON.stringify(JSON.stringify(__ssrI18nMessages)).replace(/</g, "\\u003c")})`
                : "",
            }}
          />
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
