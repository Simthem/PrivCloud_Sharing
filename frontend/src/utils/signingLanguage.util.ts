// Language of the marks a signature request draws on the PDF. It is the
// requester's, recorded with the request, and matches the backend wording.

export type SigningLanguage = "fr" | "en";

/** The interface language of the requester, reduced to what a PDF can carry. */
export function signingLanguageOf(locale: string): SigningLanguage {
  return locale.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** Requests created before the language was recorded are French. */
export function signingLanguage(value?: string | null): SigningLanguage {
  return value === "en" ? "en" : "fr";
}

export function signingDay(date: Date, language: SigningLanguage): string {
  return date.toLocaleDateString(language === "en" ? "en-GB" : "fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

export function approvalMention(date: Date, language: SigningLanguage) {
  return language === "en"
    ? `Read and approved on ${signingDay(date, language)}`
    : `Lu et approuvé le ${signingDay(date, language)}`;
}

export function approvalMentionPattern(language: SigningLanguage) {
  return language === "en"
    ? "Read and approved on (date)"
    : "Lu et approuvé, le (date)";
}

/** Name of the signed copy, the one the server gives it too. */
export function signedPdfName(
  fileName: string | null | undefined,
  language: SigningLanguage,
) {
  const base = (fileName || "document").replace(/\.pdf$/i, "");
  return `${base}${language === "en" ? "_signed" : "_signé"}.pdf`;
}

export function approvalWatermark(language: SigningLanguage) {
  return language === "en" ? "Approved" : "Bon pour Accord";
}
