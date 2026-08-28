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

export const isEmailVerificationRequiredError = (error: any): boolean =>
  error?.response?.status === 403 &&
  error?.response?.data?.error === "email_verification_required";

