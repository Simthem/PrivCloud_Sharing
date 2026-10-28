import * as crypto from "crypto";
import { Request } from "express";

// A code typed into one browser proves the mailbox for that browser only. The
// signing link may be known to others (the sender, a forwarded message): they
// must not sign or reject in the recipient's name once the recipient has
// verified the address. The browser keeps a random value, the recipient row
// only its SHA-256 hash.
export const SIGNING_EMAIL_SESSION_TTL_MS = 60 * 60 * 1000;
export const SIGNING_EMAIL_SESSION_COOKIE = "signing_session";

const VALUE = /^[A-Za-z0-9_-]{43}$/;

const digest = (value: string) =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function newSigningEmailSession(now = new Date()) {
  const value = crypto.randomBytes(32).toString("base64url");
  return {
    value,
    hash: digest(value),
    expiresAt: new Date(now.getTime() + SIGNING_EMAIL_SESSION_TTL_MS),
  };
}

/** Where a request keeps its signing session for this link, if anywhere. */
export function presentedSigningEmailSession(request: Request): unknown {
  return request.cookies?.[SIGNING_EMAIL_SESSION_COOKIE];
}

/** Whether this browser verified the recipient's address, recently. */
export function holdsSigningEmailSession(
  recipient: {
    otpVerified: boolean;
    otpSessionHash: string | null;
    otpSessionExpiresAt: Date | null;
  },
  presented: unknown,
): boolean {
  if (
    !recipient.otpVerified ||
    !recipient.otpSessionHash ||
    !recipient.otpSessionExpiresAt ||
    recipient.otpSessionExpiresAt.getTime() <= Date.now() ||
    typeof presented !== "string" ||
    !VALUE.test(presented)
  ) {
    return false;
  }
  const expected = Buffer.from(recipient.otpSessionHash, "hex");
  const actual = Buffer.from(digest(presented), "hex");
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}
