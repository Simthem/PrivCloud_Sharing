const SIGNING_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const E2E_KEY_PATTERN = /^[A-Za-z0-9_-]{16,4096}$/;

export const buildSigningNotificationActions = (
  signingToken: string,
  e2eKey?: string | null,
) => {
  if (!SIGNING_TOKEN_PATTERN.test(signingToken)) {
    throw new TypeError("Invalid signing token");
  }
  const keyFragment =
    e2eKey && E2E_KEY_PATTERN.test(e2eKey) ? `#key=${e2eKey}` : "";
  return {
    invitation: `/sign/${signingToken}${keyFragment}`,
    completion: `/sign/${signingToken}?download=1${keyFragment}`,
  };
};

export const isSafeSigningNotificationAction = (
  value: unknown,
): value is string =>
  typeof value === "string" &&
  /^\/(?:sign|signing)\/[A-Za-z0-9_-]+(?:\?download=1)?(?:#key=[A-Za-z0-9_-]{16,4096})?$/.test(
    value,
  );
