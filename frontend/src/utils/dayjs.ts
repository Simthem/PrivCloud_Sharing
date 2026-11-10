import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import duration from "dayjs/plugin/duration";
import utc from "dayjs/plugin/utc";
import relativeTime from "dayjs/plugin/relativeTime";
import fr from "dayjs/locale/fr";

// Plugins
dayjs.extend(localizedFormat);
dayjs.extend(duration);
dayjs.extend(utc);
dayjs.extend(relativeTime);

// Map application locale codes (e.g. "fr-FR") to dayjs locale names (e.g. "fr")
const localeMap: Record<string, string> = {
  "en-US": "en",
  "de-DE": "de",
  "fr-FR": "fr",
  "pt-BR": "pt-br",
  "da-DK": "da",
  "es-ES": "es",
  "zh-CN": "zh-cn",
  "zh-TW": "zh-tw",
  "fi-FI": "fi",
  "ru-RU": "ru",
  "uk-UA": "uk",
  "th-TH": "th",
  "sr-SP": "sr-cyrl",
  "sr-CS": "sr",
  "nl-BE": "nl",
  "ja-JP": "ja",
  "pl-PL": "pl",
  "sv-SE": "sv",
  "it-IT": "it",
  "el-GR": "el",
  "sl-SI": "sl",
  "ar-EG": "ar",
  "hu-HU": "hu",
  "ko-KR": "ko",
  "tr-TR": "tr",
  "cs-CZ": "cs",
  "vi-VN": "vi",
  "hr-HR": "hr",
  "et-EE": "et",
};

const localeLoaders: Record<string, () => Promise<unknown>> = {
  de: () => import("dayjs/locale/de"),
  "pt-br": () => import("dayjs/locale/pt-br"),
  da: () => import("dayjs/locale/da"),
  es: () => import("dayjs/locale/es"),
  "zh-cn": () => import("dayjs/locale/zh-cn"),
  "zh-tw": () => import("dayjs/locale/zh-tw"),
  fi: () => import("dayjs/locale/fi"),
  ru: () => import("dayjs/locale/ru"),
  uk: () => import("dayjs/locale/uk"),
  th: () => import("dayjs/locale/th"),
  "sr-cyrl": () => import("dayjs/locale/sr-cyrl"),
  sr: () => import("dayjs/locale/sr"),
  nl: () => import("dayjs/locale/nl"),
  ja: () => import("dayjs/locale/ja"),
  pl: () => import("dayjs/locale/pl"),
  sv: () => import("dayjs/locale/sv"),
  it: () => import("dayjs/locale/it"),
  el: () => import("dayjs/locale/el"),
  sl: () => import("dayjs/locale/sl"),
  ar: () => import("dayjs/locale/ar"),
  hu: () => import("dayjs/locale/hu"),
  ko: () => import("dayjs/locale/ko"),
  tr: () => import("dayjs/locale/tr"),
  cs: () => import("dayjs/locale/cs"),
  vi: () => import("dayjs/locale/vi"),
  hr: () => import("dayjs/locale/hr"),
  et: () => import("dayjs/locale/et"),
};

const loadedLocales = new Set(["en", "fr"]);
const loadingLocales = new Map<string, Promise<void>>();
let requestedLocale = "en";

const loadLocale = async (locale: string) => {
  if (loadedLocales.has(locale)) return;
  const loader = localeLoaders[locale];
  if (!loader) return;

  let loading = loadingLocales.get(locale);
  if (!loading) {
    loading = loader()
      .then(() => {
        loadedLocales.add(locale);
      })
      .finally(() => {
        loadingLocales.delete(locale);
      });
    loadingLocales.set(locale, loading);
  }

  await loading;
};

export const setDayjsLocale = async (appLocaleCode: string) => {
  const dayjsLocaleName = localeMap[appLocaleCode] ?? "en";
  requestedLocale = dayjsLocaleName;

  if (dayjsLocaleName === "fr") {
    dayjs.locale(fr);
    return;
  }

  if (dayjsLocaleName === "en") {
    dayjs.locale("en");
    return;
  }

  try {
    await loadLocale(dayjsLocaleName);
    if (requestedLocale === dayjsLocaleName) {
      dayjs.locale(dayjsLocaleName);
    }
  } catch {
    if (requestedLocale === dayjsLocaleName) {
      dayjs.locale("en");
    }
  }
};

export default dayjs;
