import createCache from "@emotion/cache";
import { readDocumentCspNonce } from "./csp.util";
import { setNonce } from "get-nonce";

// Shared emotion cache used by both _document.tsx (SSR extraction) and
// _app.tsx (MantineEmotionProvider).  Using a single instance ensures
// that styles generated during SSR are captured by extractCriticalToChunks
// and inlined into the HTML, preventing the flash of unstyled content.
export function createEmotionCache(nonce = readDocumentCspNonce()) {
  // Scroll-lock styles share this document nonce in Webpack and Turbopack.
  if (typeof document !== "undefined" && nonce) setNonce(nonce);
  return createCache({ key: "mantine", nonce });
}

// Browser cache. SSR injects a request-local cache so concurrent responses
// can never exchange their CSP nonce.
const emotionCache = createEmotionCache();

export default emotionCache;
