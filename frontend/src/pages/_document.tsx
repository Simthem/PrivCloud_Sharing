import { createGetInitialProps } from "@mantine/next";
import Document, { Head, Html, Main, NextScript, DocumentContext } from "next/document";

const mantineGetInitialProps = createGetInitialProps();

export default class _Document extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    const initialProps = await mantineGetInitialProps(ctx);

    // Extract resolved language from cookie (set by _app SSR) or Accept-Language
    let lang = "fr";
    if (ctx.req) {
      const cookieHeader = ctx.req.headers.cookie ?? "";
      const match = cookieHeader.match(/language=([^;]+)/);
      if (match) {
        lang = match[1].split("-")[0];
      } else {
        const accept = ctx.req.headers["accept-language"] ?? "";
        const primary = accept.split(",")[0]?.split(";")[0]?.trim() ?? "";
        if (primary.startsWith("en")) lang = "en";
      }
    }

    return { ...initialProps, lang };
  }

  render() {
    const lang = (this.props as any).lang ?? "fr";

    return (
      <Html lang={lang} suppressHydrationWarning>
        <Head>
          <link rel="icon" type="image/x-icon" href="/img/favicon.ico" />
          <link rel="apple-touch-icon" href="/img/icons/icon-128x128.png" />
          <link rel="manifest" href="/manifest.json" />

          <link
            rel="preload"
            href="/img/logo.webp"
            as="image"
            type="image/webp"
          />

          <meta name="robots" content="index, follow" />
          <meta name="theme-color" content="#1a1b1e" />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
