import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";

// Plugins
dayjs.extend(localizedFormat);
dayjs.extend(duration);
dayjs.extend(relativeTime);

// Import all locales as named defaults so webpack cannot tree-shake them.
// Side-effect-only imports (`import "dayjs/locale/fr"`) are unreliable with
// bundlers that mark dayjs as side-effect-free.
import de from "dayjs/locale/de";
import fr from "dayjs/locale/fr";
import ptBr from "dayjs/locale/pt-br";
import da from "dayjs/locale/da";
import es from "dayjs/locale/es";
import zhCn from "dayjs/locale/zh-cn";
import zhTw from "dayjs/locale/zh-tw";
import fi from "dayjs/locale/fi";
import ru from "dayjs/locale/ru";
import uk from "dayjs/locale/uk";
import th from "dayjs/locale/th";
import srCyrl from "dayjs/locale/sr-cyrl";
import sr from "dayjs/locale/sr";
import nl from "dayjs/locale/nl";
import ja from "dayjs/locale/ja";
import pl from "dayjs/locale/pl";
import sv from "dayjs/locale/sv";
import it from "dayjs/locale/it";
import el from "dayjs/locale/el";
import sl from "dayjs/locale/sl";
import ar from "dayjs/locale/ar";
import hu from "dayjs/locale/hu";
import ko from "dayjs/locale/ko";
import tr from "dayjs/locale/tr";
import cs from "dayjs/locale/cs";
import vi from "dayjs/locale/vi";
import hr from "dayjs/locale/hr";
import et from "dayjs/locale/et";

// Locale object map - referenced values prevent tree-shaking
const localeData: Record<string, ILocale> = {
  de, fr, "pt-br": ptBr, da, es, "zh-cn": zhCn, "zh-tw": zhTw,
  fi, ru, uk, th, "sr-cyrl": srCyrl, sr, nl, ja, pl, sv, it, el,
  sl, ar, hu, ko, tr, cs, vi, hr, et,
};

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
  const dayjsLocaleName = localeMap[appLocaleCode] ?? "en";
  const data = localeData[dayjsLocaleName];
  if (data) {
    // Pass the locale object directly - guarantees registration + activation
    dayjs.locale(data);
  } else {
    dayjs.locale(dayjsLocaleName);
  }
};

export default dayjs;
