/** @type {import('next').NextConfig} */
const { version } = require('./package.json');

const withPWA = require("@ducanh2912/next-pwa").default({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  reloadOnOnline: false,
  workboxOptions: {
    runtimeCaching: [
      {
        urlPattern: /^https?.*/,
        handler: 'NetworkOnly',
      },
    ],
  },
});

module.exports = withPWA({
  output: "standalone",
  // Next.js 16 : Turbopack est activé par défaut.
  // Le plugin @ducanh2912/next-pwa injecte une config webpack interne ;
  // déclarer turbopack: {} évite l'erreur "webpack config without turbopack config".
  turbopack: {},
  env: {
    VERSION: version,
  },
});
