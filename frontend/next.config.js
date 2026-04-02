/** @type {import('next').NextConfig} */
const { version } = require('./package.json');

// Service worker (public/sw.js) provides:
// - Offline app shell caching (network-first for pages, cache-first for assets)
// - Background upload keepalive via message channel
// - manifest.json provides full PWA install support

module.exports = {
  output: "standalone",
  turbopack: {},
  productionBrowserSourceMaps: true,
  env: {
    VERSION: version,
  },
};
