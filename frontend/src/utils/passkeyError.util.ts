import { WebAuthnError } from "@simplewebauthn/browser";

export type PasskeyErrorReason =
  | "domain"
  | "cancelled"
  | "already-registered"
  | "unsupported"
  | "stale"
  | "server"
  | "unknown";

/**
 * Turns a failed passkey ceremony into a reason the signer can act on. The
 * browser gives no detail on screen, so a generic message leaves nobody able
 * to tell a wrong address from a missing authenticator.
 */
export function describePasskeyError(error: unknown): {
  reason: PasskeyErrorReason;
  detail?: string;
} {
  const response = (
    error as {
      response?: { status?: number; data?: { message?: string | string[] } };
    }
  )?.response;
  const serverMessage = response?.data?.message;
  // The confirmation no longer matches the request (expired challenge, page
  // left open, document changed): the signer has to start over.
  if (
    response?.status === 409 ||
    (response?.status === 400 &&
      String(serverMessage).includes("challenge is invalid or expired"))
  ) {
    return { reason: "stale" };
  }
  if (serverMessage) {
    return {
      reason: "server",
      detail: Array.isArray(serverMessage)
        ? serverMessage.join(", ")
        : serverMessage,
    };
  }
  const code = error instanceof WebAuthnError ? error.code : undefined;
  const name = (error as { name?: string } | null)?.name;
  if (
    code === "ERROR_INVALID_DOMAIN" ||
    code === "ERROR_INVALID_RP_ID" ||
    name === "SecurityError"
  ) {
    return { reason: "domain" };
  }
  if (
    code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" ||
    name === "InvalidStateError"
  ) {
    return { reason: "already-registered" };
  }
  if (
    code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT" ||
    code === "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG" ||
    name === "NotSupportedError"
  ) {
    return { reason: "unsupported" };
  }
  if (
    code === "ERROR_CEREMONY_ABORTED" ||
    name === "NotAllowedError" ||
    name === "AbortError"
  ) {
    return { reason: "cancelled" };
  }
  return { reason: "unknown", detail: name || String(error) };
}
