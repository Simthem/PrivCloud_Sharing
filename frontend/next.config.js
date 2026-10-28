/** @type {import('next').NextConfig} */
const path = require("node:path");
const { version } = require("./package.json");

// Service worker (public/sw.js) provides:
// - Offline app shell caching (network-first for pages, cache-first for assets)
// - Background upload keepalive via message channel
// - manifest.json provides full PWA install support

module.exports = {
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname),
  },
  env: {
    VERSION: version,
  },
  poweredByHeader: false,
  compress: false,
  experimental: {
    // Avoid Next 16.3's detached `tsc --showConfig` parsing failure on the
    // Node versions used by the release builders.
    useTypeScriptCli: false,
    // @mantine/* v6 uses Emotion (CSS-in-JS runtime) -- barrel rewriting
    // breaks SSR style collection by @mantine/next, causing FOUC.
    // Only safe with Mantine v7+ (CSS modules). Keep non-Emotion libs only.
    optimizePackageImports: ["react-icons", "dayjs", "@tanstack/react-query"],
  },
  async redirects() {
    return [
      {
        source: "/verification/contractor",
        destination: "/verification/contractor/index.html",
        permanent: false,
      },
    ];
  },
  async headers() {
    // _document emits the request-scoped nonce CSP. Do not duplicate it here
    // or at the reverse proxy: browsers intersect multiple CSP headers.
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        source: "/img/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/_next/static/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:worker(sw|preview-sw).js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      ...[
        "/image-decoders/decoder.worker.js",
        "/video-decoders/hevc.worker.js",
      ].map((source) => ({
        source,
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'",
          },
        ],
      })),
      {
        source: "/forensic/registration.worker.js",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; object-src 'none'; base-uri 'none'",
          },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/verification/contractor/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          },
        ],
      },
      ...[
        "/s/:path*",
        "/share/:path*",
        "/upload/:token",
        "/sign/:token",
        "/external/:path*",
        "/admin/evidence-vault",
        "/auth/change-email",
      ].map((source) => ({
        source,
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      })),
    ];
  },
};
