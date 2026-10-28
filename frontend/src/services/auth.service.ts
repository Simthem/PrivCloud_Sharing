import api, { expireConfirmedSession, refreshTokenOnce } from "./api.service";
import { removeUserKey } from "../utils/crypto.util";

function isSafeLogoutRedirect(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  return (
    !url.username && !url.password && (url.protocol === "https:" || isLocalHttp)
  );
}

const signIn = async (
  emailOrUsername: string,
  password: string,
  captchaToken?: string,
) => {
  const emailOrUsernameBody = emailOrUsername.includes("@")
    ? { email: emailOrUsername }
    : { username: emailOrUsername };

  const response = await api.post("auth/signIn", {
    ...emailOrUsernameBody,
    password,
    ...(captchaToken && { captchaToken }),
  });

  return response;
};

const signInTotp = (totp: string, loginToken: string) => {
  return api.post("auth/signIn/totp", {
    totp,
    loginToken,
  });
};

const signUp = async (
  email: string,
  username: string,
  password: string,
  captchaToken?: string,
) => {
  const response = await api.post("auth/signUp", {
    email,
    username,
    password,
    ...(captchaToken && { captchaToken }),
  });

  return response;
};

const verifyEmail = async (token: string) => {
  return api.post("/auth/email-verification/verify", { token });
};

export type ResendEmailVerificationResult = {
  accepted: boolean;
  retryAfterSeconds: number;
};

const resendEmailVerification = async (
  email: string,
): Promise<ResendEmailVerificationResult> => {
  const response = await api.post<ResendEmailVerificationResult>(
    "/auth/email-verification/resend",
    { email },
  );
  return {
    accepted: response.data?.accepted ?? true,
    retryAfterSeconds: response.data?.retryAfterSeconds ?? 60,
  };
};

const requestEmailChange = async (body: {
  email: string;
  password?: string;
  code?: string;
}): Promise<{ currentAddressApproval?: boolean }> => {
  const { data } = await api.post("/auth/email-change", body);
  return data;
};
const confirmEmailChange = async (
  token: string,
): Promise<{ changed: boolean }> => {
  const result = await api.post<{ changed: boolean }>(
    "/auth/email-change/confirm",
    { token },
  );
  return result.data;
};
const cancelEmailChange = async (token: string) => {
  await api.post("/auth/email-change/cancel", { token });
};

const signOut = async () => {
  removeUserKey();

  try {
    const response = await api.post("/auth/signOut");

    // If there's an OAuth provider logout URL, use it
    if (isSafeLogoutRedirect(response.data?.redirectURI)) {
      window.location.assign(response.data.redirectURI);
      return;
    }
  } catch {
    console.error("SignOut API call failed");
    // Continue anyway -- server may have cleared cookies even if response failed
  }

  // Small delay to allow server to clear session cookie before reload
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Redirect to home instead of reload to avoid "team not found" on protected pages
  window.location.assign(new URL("/", window.location.origin).toString());
};

const refreshAccessToken = async () => {
  // Delegate to the shared single-flight refresher so this call never races
  // the axios interceptor or the upload keepalive on the token rotation.
  const result = await refreshTokenOnce();
  if (!result.ok) {
    if (result.status === 401) await expireConfirmedSession();
    console.info("Refresh token invalid or expired");
    throw new Error("token_refresh_failed");
  }
};

const hasActiveSession = async (): Promise<boolean> => {
  try {
    const { data } = await api.get("/auth/session");
    return data?.active === true;
  } catch {
    return false;
  }
};

const requestResetPassword = async (email: string, captchaToken?: string) => {
  await api.post("/auth/resetPassword/request", {
    email,
    ...(captchaToken && { captchaToken }),
  });
};

const resetPassword = async (token: string, password: string) => {
  await api.post("/auth/resetPassword", { token, password });
};

const updatePassword = async (oldPassword: string, password: string) => {
  await api.patch("/auth/password", { oldPassword, password });
};

// Without a password, the account proves a fresh sign-in with its linked OAuth
// provider instead (httpOnly reauth_confirmation cookie, see /oauth/reauth).
const enableTOTP = async (password?: string) => {
  const { data } = await api.post(
    "/auth/totp/enable",
    password ? { password } : {},
  );

  return {
    totpAuthUrl: data.totpAuthUrl,
    totpSecret: data.totpSecret,
    qrCode: data.qrCode,
  };
};

const verifyTOTP = async (totpCode: string, password?: string) => {
  const { data } = await api.post("/auth/totp/verify", {
    code: totpCode,
    ...(password ? { password } : {}),
  });
  return { backupCodes: data.backupCodes as string[] };
};

const disableTOTP = async (totpCode: string, password?: string) => {
  await api.post("/auth/totp/disable", {
    code: totpCode,
    ...(password ? { password } : {}),
  });
};

export type StepUpMethods = {
  password: boolean;
  totp: boolean;
  passkey: boolean;
  providers: string[];
};

const getStepUpMethods = async (): Promise<StepUpMethods> =>
  (await api.get("/auth/step-up")).data;

// Without a password, the fresh linked sign-in (httpOnly reauth_confirmation
// cookie, see /oauth/reauth?purpose=admin) stands in for it.
const confirmStepUp = async (
  scope: string,
  proof: { password?: string; code?: string },
) => {
  await api.post("/auth/step-up", {
    scope,
    ...(proof.password ? { password: proof.password } : {}),
    ...(proof.code ? { code: proof.code } : {}),
  });
};

const getAvailableOAuth = async () => {
  return api.get("/oauth/available");
};

const getOAuthStatus = () => {
  return api.get("/oauth/status");
};

export default {
  requestEmailChange,
  confirmEmailChange,
  cancelEmailChange,
  signIn,
  signInTotp,
  signUp,
  verifyEmail,
  resendEmailVerification,
  signOut,
  refreshAccessToken,
  hasActiveSession,
  updatePassword,
  requestResetPassword,
  resetPassword,
  enableTOTP,
  verifyTOTP,
  disableTOTP,
  getStepUpMethods,
  confirmStepUp,
  getAvailableOAuth,
  getOAuthStatus,
};
