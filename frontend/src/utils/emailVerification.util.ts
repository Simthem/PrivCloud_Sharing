import type { ThrownError } from "../types/thrownError.type";
import { isInvitationRoutePath, safeRedirectPath } from "./authRedirect.util";
const EMAIL_KEY = "privcloud_email_verification_email";

export const rememberEmailVerificationEmail = (email: string) => {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(EMAIL_KEY, email.trim());
};

export const getRememberedEmailVerificationEmail = (): string => {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(EMAIL_KEY) ?? "";
};

export const clearRememberedEmailVerificationEmail = () => {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(EMAIL_KEY);
};

// Address an invitation was sent to, prefilled on the sign-up form of this
// tab. Kept out of the URL so it never reaches request logs.
const INVITED_EMAIL_ITEM = "privcloud_invited_signup_email";

export const rememberInvitedSignUpEmail = (email: string) => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(INVITED_EMAIL_ITEM, email.trim().toLowerCase());
  } catch {
    // Storage can be unavailable: the user types the address.
  }
};

export const takeInvitedSignUpEmail = (): string => {
  if (typeof window === "undefined") return "";
  try {
    const email = sessionStorage.getItem(INVITED_EMAIL_ITEM) ?? "";
    sessionStorage.removeItem(INVITED_EMAIL_ITEM);
    return email;
  } catch {
    return "";
  }
};

// The verification link usually opens in a new tab: the way back to an
// invitation has to outlive the tab that signed up, as long as the link does.
const VERIFICATION_RETURN_ITEM = "privcloud_email_verification_return";
const VERIFICATION_RETURN_TTL_MS = 24 * 60 * 60 * 1000;

export const rememberVerificationReturn = (path: string) => {
  try {
    localStorage.setItem(
      VERIFICATION_RETURN_ITEM,
      JSON.stringify({
        path,
        expiresAt: Date.now() + VERIFICATION_RETURN_TTL_MS,
      }),
    );
  } catch {
    // Storage can be unavailable: the user reopens the invitation.
  }
};

export const takeVerificationReturn = (): string | null => {
  try {
    const raw = localStorage.getItem(VERIFICATION_RETURN_ITEM);
    localStorage.removeItem(VERIFICATION_RETURN_ITEM);
    if (!raw) return null;
    const { path, expiresAt } = JSON.parse(raw) as {
      path?: unknown;
      expiresAt?: unknown;
    };
    const valid =
      typeof path === "string" &&
      typeof expiresAt === "number" &&
      expiresAt > Date.now() &&
      isInvitationRoutePath(
        new URL(safeRedirectPath(path), "https://app.invalid").pathname,
      );
    return valid ? path : null;
  } catch {
    return null;
  }
};

export const isEmailVerificationRequiredError = (error: unknown): boolean => {
  const response = (error as ThrownError | null)?.response;
  return (
    response?.status === 403 &&
    response.data?.error === "email_verification_required"
  );
};
