/** Messages _document.tsx injects into the page. */
interface Window {
  __I18N__?: Record<string, string>;
  __I18N_PARTIAL__?: boolean;
}

/** WebAuthn Level 3, not yet in the TypeScript DOM library. */
interface PublicKeyCredentialCapabilities {
  getClientCapabilities?(): Promise<Record<string, boolean>>;
}
