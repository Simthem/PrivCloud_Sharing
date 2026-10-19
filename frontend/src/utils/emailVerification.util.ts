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

export const isEmailVerificationRequiredError = (error: any): boolean =>
  error?.response?.status === 403 &&
  error?.response?.data?.error === "email_verification_required";

