// Team notifications written by the server reach the database, Web Push
// services, open sockets and lock screens. They therefore never name a member,
// a team, a folder or a file: the details are read in the app by the members
// who can open them, or come from an envelope encrypted in the browser.

const french = {
  FILE_SHARED: "Un fichier a été partagé avec vous",
  FILE_UPLOADED: "Nouveau contenu dans un dossier de votre équipe",
  FILE_DELETED: "Des fichiers ont été supprimés dans votre équipe",
  GRANT_RECEIVED: "Un accès vous a été accordé",
  GRANT_REVOKED: "Un de vos accès a été retiré",
  KEY_ROTATED: "La clé de votre équipe a été renouvelée",
  MEMBER_JOINED: "Un membre a rejoint votre équipe",
  MEMBER_LEFT: "Un membre a quitté votre équipe",
  pushBody: "Ouvrez l'application pour voir le détail",
} as const;

const english = {
  FILE_SHARED: "A file was shared with you",
  FILE_UPLOADED: "New content in one of your team folders",
  FILE_DELETED: "Files were deleted in your team",
  GRANT_RECEIVED: "You were granted access",
  GRANT_REVOKED: "One of your accesses was removed",
  KEY_ROTATED: "Your team key was renewed",
  MEMBER_JOINED: "A member joined your team",
  MEMBER_LEFT: "A member left your team",
  pushBody: "Open the app to see the details",
} as const;

export type GenericTeamNotificationType = Exclude<
  keyof typeof french,
  "pushBody"
>;

// Account language is a browser preference the server does not know, so the
// text carries both languages, as file request notifications do.
const both = (key: keyof typeof french) => `${french[key]} / ${english[key]}`;

export function isGenericTeamNotificationType(
  type: string,
): type is GenericTeamNotificationType {
  return (
    type !== "pushBody" && Object.prototype.hasOwnProperty.call(french, type)
  );
}

export function teamNotificationTitle(type: GenericTeamNotificationType) {
  return both(type);
}

export const TEAM_NOTIFICATION_PUSH_BODY = both("pushBody");

/** Identifiers used to open the right page. Never names or free text. */
const NAVIGATION_KEYS = [
  "highlightFileId",
  "shareId",
  "signingDocumentId",
] as const;

export function navigationMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const kept: Record<string, string> = {};
  for (const key of NAVIGATION_KEYS) {
    const value = metadata[key];
    if (
      typeof value === "string" &&
      (/^[A-Za-z0-9_-]{1,128}$/.test(value) ||
        (key === "shareId" && /^v2\.[A-Za-z0-9_-]{3,47}$/.test(value)))
    ) {
      kept[key] = value;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}
