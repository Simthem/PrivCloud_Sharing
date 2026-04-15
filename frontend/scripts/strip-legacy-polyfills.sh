#!/bin/sh
# Strip the built-in Next.js module polyfills that target legacy browsers.
# Our browserslist only targets the last 2 versions of modern browsers,
# so Array.at, flat, flatMap, Object.fromEntries, Object.hasOwn,
# String.trimStart/trimEnd, etc. are all natively supported (~15 KiB saved).
POLYFILL="node_modules/next/dist/build/polyfills/polyfill-module.js"
if [ -f "$POLYFILL" ]; then
  printf '// intentionally empty -- modern browsers only\n' > "$POLYFILL"
fi
