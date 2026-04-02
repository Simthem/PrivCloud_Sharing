import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";

// Plugins
dayjs.extend(localizedFormat);
dayjs.extend(duration);
dayjs.extend(relativeTime);

// Import all locales used by the application
import "dayjs/locale/de";
import "dayjs/locale/fr";
import "dayjs/locale/pt-br";
import "dayjs/locale/da";
import "dayjs/locale/es";
import "dayjs/locale/zh-cn";
import "dayjs/locale/zh-tw";
import "dayjs/locale/fi";
import "dayjs/locale/ru";
import "dayjs/locale/uk";
import "dayjs/locale/th";
import "dayjs/locale/sr-cyrl";
import "dayjs/locale/sr";
import "dayjs/locale/nl";
import "dayjs/locale/ja";
import "dayjs/locale/pl";
import "dayjs/locale/sv";
import "dayjs/locale/it";
import "dayjs/locale/el";
import "dayjs/locale/sl";
import "dayjs/locale/ar";
import "dayjs/locale/hu";
import "dayjs/locale/ko";
import "dayjs/locale/tr";
import "dayjs/locale/cs";
import "dayjs/locale/vi";
import "dayjs/locale/hr";
import "dayjs/locale/et";

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

export const setDayjsLocale = (appLocaleCode: string) => {
  const dayjsLocale = localeMap[appLocaleCode] ?? "en";
  dayjs.locale(dayjsLocale);
};

export default dayjs;
