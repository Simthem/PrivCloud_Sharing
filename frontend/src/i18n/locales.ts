import english from "./translations/en-US";

export const englishMessages: Record<string, string> = english;

// Global message cache for translateOutsideContext (set during render)
let _activeMessages: Record<string, string> = english;
export function setActiveMessages(m: Record<string, string>) {
  _activeMessages = m;
}
export function getActiveMessages(): Record<string, string> {
  return _activeMessages;
}

// Load a single locale on demand -- each case becomes its own chunk.
// On SSR: resolved instantly (same process). On client navigation:
// fetches only the ONE ~30-50KB chunk needed.
export async function loadLocaleMessages(
  code: string,
): Promise<Record<string, string>> {
  switch (code) {
    case "ar-EG": return (await import("./translations/ar-EG")).default;
    case "cs-CZ": return (await import("./translations/cs-CZ")).default;
    case "da-DK": return (await import("./translations/da-DK")).default;
    case "de-DE": return (await import("./translations/de-DE")).default;
    case "el-GR": return (await import("./translations/el-GR")).default;
    case "es-ES": return (await import("./translations/es-ES")).default;
    case "et-EE": return (await import("./translations/et-EE")).default;
    case "fi-FI": return (await import("./translations/fi-FI")).default;
    case "fr-FR": return (await import("./translations/fr-FR")).default;
    case "hr-HR": return (await import("./translations/hr-HR")).default;
    case "hu-HU": return (await import("./translations/hu-HU")).default;
    case "it-IT": return (await import("./translations/it-IT")).default;
    case "ja-JP": return (await import("./translations/ja-JP")).default;
    case "ko-KR": return (await import("./translations/ko-KR")).default;
    case "nl-BE": return (await import("./translations/nl-BE")).default;
    case "pl-PL": return (await import("./translations/pl-PL")).default;
    case "pt-BR": return (await import("./translations/pt-BR")).default;
    case "ru-RU": return (await import("./translations/ru-RU")).default;
    case "sl-SI": return (await import("./translations/sl-SI")).default;
    case "sr-CS": return (await import("./translations/sr-CS")).default;
    case "sr-SP": return (await import("./translations/sr-SP")).default;
    case "sv-SE": return (await import("./translations/sv-SE")).default;
    case "th-TH": return (await import("./translations/th-TH")).default;
    case "tr-TR": return (await import("./translations/tr-TR")).default;
    case "uk-UA": return (await import("./translations/uk-UA")).default;
    case "vi-VN": return (await import("./translations/vi-VN")).default;
    case "zh-CN": return (await import("./translations/zh-CN")).default;
    case "zh-TW": return (await import("./translations/zh-TW")).default;
    default: return english;
  }
}

export const LOCALES = {
  ENGLISH: { name: "English", code: "en-US" },
  GERMAN: { name: "Deutsch", code: "de-DE" },
  FRENCH: { name: "Français", code: "fr-FR" },
  PORTUGUESE_BRAZIL: { name: "Português (Brasil)", code: "pt-BR" },
  DANISH: { name: "Dansk", code: "da-DK" },
  SPANISH: { name: "Español", code: "es-ES" },
  CHINESE_SIMPLIFIED: { name: "简体中文", code: "zh-CN" },
  CHINESE_TRADITIONAL: { name: "正體中文", code: "zh-TW" },
  FINNISH: { name: "Suomi", code: "fi-FI" },
  RUSSIAN: { name: "Русский", code: "ru-RU" },
  UKRAINIAN: { name: "Українська", code: "uk-UA" },
  THAI: { name: "ไทย", code: "th-TH" },
  SERBIAN: { name: "Српски", code: "sr-SP" },
  SERBIAN_LATIN: { name: "Srpski", code: "sr-CS" },
  DUTCH: { name: "Nederlands", code: "nl-BE" },
  JAPANESE: { name: "日本語", code: "ja-JP" },
  POLISH: { name: "Polski", code: "pl-PL" },
  SWEDISH: { name: "Svenska", code: "sv-SE" },
  ITALIAN: { name: "Italiano", code: "it-IT" },
  GREEK: { name: "Ελληνικά", code: "el-GR" },
  SLOVENIAN: { name: "Slovenščina", code: "sl-SI" },
  ARABIC: { name: "العربية", code: "ar-EG" },
  HUNGARIAN: { name: "Hungarian", code: "hu-HU" },
  KOREAN: { name: "한국어", code: "ko-KR" },
  TURKISH: { name: "Türkçe", code: "tr-TR" },
  CZECH: { name: "Čeština", code: "cs-CZ" },
  VIATNAMESE: { name: "Tiếng Việt", code: "vi-VN" },
  CROATIAN: { name: "Hrvatski", code: "hr-HR" },
  ESTONIAN: { name: "Eesti", code: "et-EE" },
};
