import createCache from "@emotion/cache";

// Shared emotion cache used by both _document.tsx (SSR extraction) and
// _app.tsx (MantineEmotionProvider).  Using a single instance ensures
// that styles generated during SSR are captured by extractCriticalToChunks
// and inlined into the HTML, preventing the flash of unstyled content.
const emotionCache = createCache({ key: "mantine" });

export default emotionCache;
