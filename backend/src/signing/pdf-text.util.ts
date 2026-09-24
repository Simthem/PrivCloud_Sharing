/**
 * The standard PDF fonts only encode WinAnsi, and pdf-lib throws on any other
 * character. A signer called "Łukasz" or a typed emoji would then block the
 * finalization of the whole request. Text drawn with those fonts goes through
 * this function: encodable characters are kept, Latin letters are reduced to
 * their base letter, anything else becomes "?". The exact Unicode values stay
 * in the evidence bundle and the audit trail. The same file exists in the
 * frontend for the E2E finalization.
 */

type EncodableFont = { getCharacterSet(): number[] };

const LATIN_FALLBACKS: Record<string, string> = {
  Ł: "L",
  ł: "l",
  Đ: "D",
  đ: "d",
  Ħ: "H",
  ħ: "h",
  ı: "i",
  Ŀ: "L",
  ŀ: "l",
  Ŋ: "N",
  ŋ: "n",
  Ŧ: "T",
  ŧ: "t",
  Ə: "E",
  ə: "e",
};

const charsets = new WeakMap<object, Set<number>>();

const charsetOf = (font: EncodableFont) => {
  let charset = charsets.get(font);
  if (!charset) {
    charset = new Set(font.getCharacterSet());
    charsets.set(font, charset);
  }
  return charset;
};

export function pdfSafeText(text: string, font: EncodableFont): string {
  const charset = charsetOf(font);
  const encodable = (value: string) =>
    [...value].every((char) => charset.has(char.codePointAt(0)!));
  let result = "";
  for (const char of text.replace(/[\u0000-\u001f\u007f]+/g, " ")) {
    if (encodable(char)) {
      result += char;
      continue;
    }
    const fallback =
      LATIN_FALLBACKS[char] ??
      char.normalize("NFD").replace(/[̀-ͯ]/g, "");
    result += fallback && encodable(fallback) ? fallback : "?";
  }
  return result;
}
