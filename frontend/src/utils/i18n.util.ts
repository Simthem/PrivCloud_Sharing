import { setCookie } from "cookies-next";
import { LOCALES } from "../i18n/locales";

const getLocaleByCode = (code: string) => {
  return Object.values(LOCALES).find((l) => l.code === code) ?? LOCALES.ENGLISH;
};

// Return true if the code matches a known locale (exact or prefix).
const resolveCode = (code: string): string | undefined => {
  const all = Object.values(LOCALES);
  const codes = all.map((l) => l.code);
  if (codes.includes(code)) return code;
  const prefix = code.split("-")[0];
  return codes.find((c) => c.startsWith(prefix));
};

// Parse the Accept-Language header and return the first supported language code.
const getLanguageFromAcceptHeader = (acceptLanguage?: string): string => {
  if (!acceptLanguage) return "en-US";

  const languages = acceptLanguage.split(",").map((l) => l.split(";")[0].trim());

  for (const language of languages) {
    const resolved = resolveCode(language);
    if (resolved) return resolved;
  }
  return "en-US";
};

const isLanguageSupported = (code: string) => {
  return Object.values(LOCALES).some((l) => l.code === code);
};

const setLanguageCookie = (code: string) => {
  setCookie("language", code, {
    sameSite: "lax",
    expires: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
  });
};

export default {
  getLocaleByCode,
  getLanguageFromAcceptHeader,
  isLanguageSupported,
  setLanguageCookie,
};
