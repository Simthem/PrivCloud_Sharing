/** @type {import('next').NextConfig} */
const { version } = require('./package.json');

// PWA plugin disabled – @ducanh2912/next-pwa generates its precache
// manifest via webpack, but Next.js 16 builds with Turbopack by default.
// The stale manifest was referencing non-existent chunks (dynamic-css-manifest.json,
// old webpack chunk hashes) causing the service-worker install to fail and
// serving cached content from a previous build → React hydration error #418.
//
// A cleanup service worker (public/sw.js) purges all caches and unregisters
// itself on the first visit after deploy.  The manifest.json in public/
// still provides basic PWA "add to home screen" support.

module.exports = {
  output: "standalone",
  turbopack: {},
  env: {
    VERSION: version,
  },
};
