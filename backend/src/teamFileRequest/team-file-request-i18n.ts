import french from "./i18n/fr-FR";
import english from "./i18n/en-US";

export const fileRequestMessages = { "fr-FR": french, "en-US": english };

// Account language is currently a browser preference. Service messages include
// both languages so the sender's preference cannot override the recipient's.
export function fileRequestServiceMessage(
  key: "request" | "submitted" | "pushBody" | "emailSubject",
): string {
  return [french[key], english[key]].join(" / ");
}

export function fileRequestServiceEmail(url: string) {
  return {
    subject: fileRequestServiceMessage("emailSubject") + " - PrivCloud Sharing",
    text:
      [french.emailBody, english.emailBody]
        .map((body) => body.replace("{url}", url))
        .join("\n\n") + "\n\nPrivCloud Sharing",
  };
}
