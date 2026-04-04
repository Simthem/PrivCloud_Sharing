import { getCookie } from "cookies-next";
import api from "./api.service";

const signIn = async (emailOrUsername: string, password: string, captchaToken?: string) => {
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

const signUp = async (email: string, username: string, password: string, captchaToken?: string) => {
  const response = await api.post("auth/signUp", { email, username, password, ...(captchaToken && { captchaToken }) });

  return response;
};

const signOut = async () => {
  const response = await api.post("/auth/signOut");

  if (URL.canParse(response.data?.redirectURI))
    window.location.href = response.data.redirectURI;
  else window.location.reload();
};

const refreshAccessToken = async () => {
  // The access_token cookie maxAge (13 min) is shorter than the JWT
  // lifetime (15 min). When the cookie disappears the token is about
  // to expire, so we proactively request a new one via the refresh
  // token. No client-side JWT decode is needed.
  if (!getCookie("access_token")) {
    try {
      await api.post("/auth/token");
    } catch (e) {
      console.info("Refresh token invalid or expired");
      throw e;
    }
  }
};

const requestResetPassword = async (email: string, captchaToken?: string) => {
  await api.post(`/auth/resetPassword/${email}`, { ...(captchaToken && { captchaToken }) });
};

const resetPassword = async (token: string, password: string) => {
  await api.post("/auth/resetPassword", { token, password });
};

const updatePassword = async (oldPassword: string, password: string) => {
  await api.patch("/auth/password", { oldPassword, password });
};

const enableTOTP = async (password: string) => {
  const { data } = await api.post("/auth/totp/enable", { password });

  return {
    totpAuthUrl: data.totpAuthUrl,
    totpSecret: data.totpSecret,
    qrCode: data.qrCode,
  };
};

const verifyTOTP = async (totpCode: string, password: string) => {
  await api.post("/auth/totp/verify", {
    code: totpCode,
    password,
  });
};

const disableTOTP = async (totpCode: string, password: string) => {
  await api.post("/auth/totp/disable", {
    code: totpCode,
    password,
  });
};

const getAvailableOAuth = async () => {
  return api.get("/oauth/available");
};

const getOAuthStatus = () => {
  return api.get("/oauth/status");
};

export default {
  signIn,
  signInTotp,
  signUp,
  signOut,
  refreshAccessToken,
  updatePassword,
  requestResetPassword,
  resetPassword,
  enableTOTP,
  verifyTOTP,
  disableTOTP,
  getAvailableOAuth,
  getOAuthStatus,
};
