import { setCookie } from "cookies-next";
import { LOCALES } from "../i18n/locales";
import {
  isChosenLanguage,
  LANGUAGE_CHOICE_COOKIE,
  languageParameter,
} from "./authRedirect.util";

const getLocaleByCode = (code: string) => {
  return Object.values(LOCALES).find((l) => l.code === code) ?? LOCALES.ENGLISH;
};

// Return the known locale matching the code (exact, any case, or prefix).
const resolveCode = (code: string): string | undefined => {
  const all = Object.values(LOCALES);
  const codes = all.map((l) => l.code);
  if (codes.includes(code)) return code;
  const lowered = code.toLowerCase();
  const exact = codes.find((c) => c.toLowerCase() === lowered);
  if (exact) return exact;
  const prefix = lowered.split("-")[0];
  return codes.find((c) => c.toLowerCase().startsWith(`${prefix}-`));
};

// Parse the Accept-Language header and return the first supported language code.
const getLanguageFromAcceptHeader = (acceptLanguage?: string): string => {
  if (!acceptLanguage) return "en-US";

  const languages = acceptLanguage
    .split(",")
    .map((l) => l.split(";")[0].trim());

  for (const language of languages) {
    const resolved = resolveCode(language);
    if (resolved) return resolved;
  }
  return "en-US";
};

// Link parameter, then a cookie for languages the URL cannot carry, then the URL locale.
const pageLanguage = (request: {
  parameter?: unknown;
  cookie?: string;
  locale?: string;
}): string => {
  const linked = languageParameter(request.parameter);
  return (
    (linked && resolveCode(linked)) ??
    (request.cookie && isChosenLanguage(request.cookie)
      ? request.cookie
      : request.locale === "en"
        ? "en-US"
        : "fr-FR")
  );
};

const isLanguageSupported = (code: string) => {
  return Object.values(LOCALES).some((l) => l.code === code);
};

const setLanguageCookie = (code: string, chosen = false) => {
  const options = {
    sameSite: "lax" as const,
    expires: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
  };
  setCookie("language", code, options);
  if (chosen) setCookie(LANGUAGE_CHOICE_COOKIE, "1", options);
};

export default {
  getLocaleByCode,
  pageLanguage,
  getLanguageFromAcceptHeader,
  isLanguageSupported,
  setLanguageCookie,
};
