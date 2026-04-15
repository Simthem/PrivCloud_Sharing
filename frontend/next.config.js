/** @type {import('next').NextConfig} */
const { version } = require('./package.json');

// Service worker (public/sw.js) provides:
// - Offline app shell caching (network-first for pages, cache-first for assets)
// - Background upload keepalive via message channel
// - manifest.json provides full PWA install support

module.exports = {
  output: "standalone",
  turbopack: {},
  env: {
    VERSION: version,
  },
  poweredByHeader: false,
  compress: false,
  experimental: {
    // @mantine/* v6 uses Emotion (CSS-in-JS runtime) -- barrel rewriting
    // breaks SSR style collection by @mantine/next, causing FOUC.
    // Only safe with Mantine v7+ (CSS modules). Keep non-Emotion libs only.
    optimizePackageImports: [
      'react-icons',
      'dayjs',
      '@tanstack/react-query',
    ],
  },
  async headers() {
    // CSP is enforced at the upstream nginx reverse proxy level
    // (share.conf). Do NOT duplicate it here -- browsers enforce the
    // intersection of multiple CSP headers (most restrictive wins),
    // which can silently break hCaptcha or other third-party scripts.
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/img/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/_next/static/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};
