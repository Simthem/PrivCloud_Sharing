const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,}$/;

/** Build the HTML policy around one unpredictable, request-scoped nonce. */
export function buildContentSecurityPolicy(
  nonce: string,
  development = process.env.NODE_ENV === "development",
): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Invalid CSP nonce");

  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development ? ["'unsafe-eval'"] : []),
  ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "script-src-attr 'none'",
    `style-src 'self' https: 'nonce-${nonce}'`,
    `style-src-elem 'self' https: 'nonce-${nonce}'`,
    // Nonces cannot authorize style attributes. React and Mantine generate
    // those dynamically, so keep this narrowly scoped compatibility rule.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https: wss: http://localhost:47631 http://127.0.0.1:47631",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' blob: https:",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function readDocumentCspNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const nonce = document
    .querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
    ?.getAttribute("content");
  return nonce && NONCE_PATTERN.test(nonce) ? nonce : undefined;
}

export function shouldEmbedCspMeta(
  hasHttpResponse: boolean,
  buildTarget = process.env.BUILD_TARGET,
): boolean {
  return buildTarget === "capacitor" || !hasHttpResponse;
}
