// Language of everything a signature request produces: its mails, the marks
// drawn on the PDF and the evidence dossier. It is the requester's, chosen
// when the request is created.

export const SIGNING_LANGUAGES = ["fr", "en"] as const;
export type SigningLanguage = (typeof SIGNING_LANGUAGES)[number];

/** Requests created before the language was recorded are French. */
export function signingLanguage(value?: string | null): SigningLanguage {
  return value === "en" ? "en" : "fr";
}

const DATE_LOCALES: Record<SigningLanguage, string> = {
  fr: "fr-FR",
  en: "en-GB",
};

const TIME_ZONE = "Europe/Paris";

/** Calendar date, as written in the approval mention and date fields. */
export function signingDay(date: Date, language: SigningLanguage): string {
  return date.toLocaleDateString(DATE_LOCALES[language], {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  });
}

export function signingDateTime(
  date: Date,
  language: SigningLanguage,
  timeStyle: "short" | "medium" = "medium",
): string {
  return date.toLocaleString(DATE_LOCALES[language], {
    dateStyle: "long",
    timeStyle,
    timeZone: TIME_ZONE,
  });
}

export function approvalMention(date: Date, language: SigningLanguage) {
  return language === "en"
    ? `Read and approved on ${signingDay(date, language)}`
    : `Lu et approuvé le ${signingDay(date, language)}`;
}

export function approvalWatermark(language: SigningLanguage) {
  return language === "en" ? "Approved" : "Bon pour Accord";
}

export function signedFileName(fileName: string, language: SigningLanguage) {
  const base = fileName.replace(/\.pdf$/i, "");
  return `${base}${language === "en" ? "_signed" : "_signé"}.pdf`;
}

const SIGNATURE = "-- \nPrivCloud Sharing - ";

const mails = {
  fr: {
    footer: `${SIGNATURE}Signature Électronique`,
    hello: (name: string) => `Bonjour ${name},\n\n`,
    level: (reinforced: boolean) =>
      reinforced
        ? "Renforcé (compte vérifié + passkey)"
        : "Standard (code e-mail + consentement)",
    codeSubject: (file: string) =>
      `Code de vérification de signature - ${file}`,
    codeBody: (code: string) =>
      `Votre code de vérification PrivCloud est : ${code}\n\n` +
      `Il expire dans 10 minutes et permet de confirmer le contrôle de ` +
      `l'adresse e-mail destinataire avant toute signature ou tout refus.\n\n` +
      `Ne transmettez ce code à personne. Si vous n'avez pas demandé cette ` +
      `signature, ignorez ce message.\n\n`,
    passkeyCodeSubject: (file: string) =>
      `Code de confirmation de passkey - ${file}`,
    passkeyCodeBody: (code: string) =>
      `Votre code de confirmation PrivCloud est : ${code}\n\n` +
      `Il expire dans 10 minutes et confirme votre identité avant ` +
      `l'enregistrement d'une passkey de signature pour ce document.\n\n` +
      `Ne transmettez ce code à personne. Si vous n'êtes pas à l'origine de ` +
      `cette demande, ignorez ce message.\n\n`,
    invitationSubject: (file: string, reminder: boolean) =>
      `${reminder ? "Rappel : " : ""}Signature requise - ${file}`,
    invitationBody: (o: {
      file: string;
      reminder: boolean;
      message?: string | null;
      url: string;
      reinforced: boolean;
    }) =>
      (o.reminder ? "Ceci est un rappel. " : "") +
      `Vous avez reçu une demande de signature électronique pour le document "${o.file}".\n\n` +
      (o.message ? `Message de l'expéditeur :\n${o.message}\n\n` : "") +
      `Pour signer ce document, cliquez sur le lien ci-dessous :\n${o.url}\n\n` +
      `Ce lien est personnel et sécurisé. Ne le partagez pas.\n\n` +
      `Niveau de preuve : ${mails.fr.level(o.reinforced)}\n\n`,
    ccSubject: (file: string) => `Copie : Demande de signature - ${file}`,
    ccBody: (sender: string, file: string) =>
      `${sender} a envoyé une demande de signature électronique ` +
      `pour le document "${file}".\n\n` +
      `Vous êtes en copie de cette demande. Vous serez notifié(e) lorsque tous les signataires auront signé.\n\n`,
    keySubject: (file: string) => `Clé de déchiffrement E2E - ${file}`,
    keyBody: (file: string, fragment: string) =>
      `Vous recevez cet email séparé car l'expéditeur a choisi de vous transmettre ` +
      `la clé de déchiffrement du document "${file}" par email.\n\n` +
      `Le lien personnel de signature reste dans l'email principal. Pour ouvrir le document, ` +
      `ajoutez le fragment ci-dessous à la fin de ce lien :\n${fragment}\n\n` +
      `Si votre invitation principale n'est pas encore arrivée, conservez cet email : ` +
      `elle peut être envoyée plus tard selon l'ordre de signature.\n\n` +
      `Ne transférez pas cette clé et ne la publiez pas.\n\n`,
    signedSubject: (file: string, signed: number, total: number) =>
      `Signature reçue (${signed}/${total}) - ${file}`,
    signedBody: (o: {
      signer: string;
      file: string;
      signed: number;
      total: number;
      url: string;
    }) =>
      `${o.signer} a signé le document "${o.file}".\n\n` +
      `Progression : ${o.signed}/${o.total} signataires.\n\n` +
      `Suivez l'avancement ici :\n${o.url}\n\n`,
    rejectedSubject: (file: string) => `Signature refusée - ${file}`,
    rejectedBody: (signer: string, file: string, reason?: string | null) =>
      `${signer} a refusé de signer le document "${file}".\n\n` +
      (reason ? `Raison : ${reason}\n\n` : "") +
      `La demande de signature a été annulée.`,
    cancelledSubject: (file: string) => `Signature annulée - ${file}`,
    cancelledBody: (file: string) =>
      `La demande de signature pour le document "${file}" a été annulée par l'expéditeur.`,
    failedSubject: (file: string) => `Erreur de finalisation - ${file}`,
    failedBody: (file: string, url: string) =>
      `La finalisation automatique du document "${file}" a échoué.\n` +
      `Toutes les signatures ont été collectées mais le document n'a pas pu être finalisé.\n\n` +
      `Vous pouvez réessayer en vous rendant sur :\n${url}\n\n` +
      `Si le problème persiste, contactez le support.\n\n`,
    signerLine: (signer: string, signedAt: string) =>
      `  - ${signer} - signé le ${signedAt}`,
    completedCreatorSubject: (file: string) =>
      `Document signé par tous les signataires - ${file}`,
    completedCreatorBody: (o: {
      file: string;
      signers: string;
      url: string;
      team: boolean;
    }) =>
      `Le document "${o.file}" a été signé par l'ensemble des signataires et finalisé avec succès.\n\n` +
      `Signataires :\n${o.signers}\n\n` +
      `La signature cryptographique PAdES a été appliquée.\n\n` +
      `Consultez et téléchargez le document signé ici :\n${o.url}\n\n` +
      (o.team
        ? `Ce document est également visible dans l'espace de votre équipe.\n\n`
        : ""),
    completedSubject: (file: string) => `Document signé - ${file}`,
    completedBody: (o: {
      file: string;
      signers: string;
      url: string;
      account: boolean;
    }) =>
      `Le document "${o.file}" a été signé par tous les signataires et la signature cryptographique PAdES a été appliquée.\n\n` +
      `Signataires :\n${o.signers}\n\n` +
      (o.account
        ? `Vous pouvez consulter et télécharger le document signé depuis votre espace :\n${o.url}\n\n` +
          `Ce document apparaît également dans votre rubrique "Documents reçus" de l'onglet Signature.\n\n`
        : `Si vous avez un compte PrivCloud Sharing, connectez-vous pour retrouver ce document dans vos "Documents reçus".\n\n`),
  },
  en: {
    footer: `${SIGNATURE}Electronic Signature`,
    hello: (name: string) => `Hello ${name},\n\n`,
    level: (reinforced: boolean) =>
      reinforced
        ? "Reinforced (verified account + passkey)"
        : "Standard (e-mail code + consent)",
    codeSubject: (file: string) => `Signature verification code - ${file}`,
    codeBody: (code: string) =>
      `Your PrivCloud verification code is: ${code}\n\n` +
      `It expires in 10 minutes and confirms that you control the recipient ` +
      `e-mail address before any signature or rejection.\n\n` +
      `Do not share this code with anyone. If you did not request this ` +
      `signature, ignore this message.\n\n`,
    passkeyCodeSubject: (file: string) => `Passkey confirmation code - ${file}`,
    passkeyCodeBody: (code: string) =>
      `Your PrivCloud confirmation code is: ${code}\n\n` +
      `It expires in 10 minutes and confirms your identity before a signing ` +
      `passkey is registered for this document.\n\n` +
      `Do not share this code with anyone. If you did not ask for it, ` +
      `ignore this message.\n\n`,
    invitationSubject: (file: string, reminder: boolean) =>
      `${reminder ? "Reminder: " : ""}Signature required - ${file}`,
    invitationBody: (o: {
      file: string;
      reminder: boolean;
      message?: string | null;
      url: string;
      reinforced: boolean;
    }) =>
      (o.reminder ? "This is a reminder. " : "") +
      `You have received an electronic signature request for the document "${o.file}".\n\n` +
      (o.message ? `Message from the sender:\n${o.message}\n\n` : "") +
      `To sign this document, click the link below:\n${o.url}\n\n` +
      `This link is personal and secure. Do not share it.\n\n` +
      `Evidence level: ${mails.en.level(o.reinforced)}\n\n`,
    ccSubject: (file: string) => `Copy: Signature request - ${file}`,
    ccBody: (sender: string, file: string) =>
      `${sender} sent an electronic signature request ` +
      `for the document "${file}".\n\n` +
      `You are copied on this request. You will be notified once every signer has signed.\n\n`,
    keySubject: (file: string) => `E2E decryption key - ${file}`,
    keyBody: (file: string, fragment: string) =>
      `You are receiving this separate email because the sender chose to send you ` +
      `the decryption key of the document "${file}" by email.\n\n` +
      `Your personal signing link stays in the main email. To open the document, ` +
      `add the fragment below to the end of that link:\n${fragment}\n\n` +
      `If your main invitation has not arrived yet, keep this email: ` +
      `it may be sent later, depending on the signing order.\n\n` +
      `Do not forward or publish this key.\n\n`,
    signedSubject: (file: string, signed: number, total: number) =>
      `Signature received (${signed}/${total}) - ${file}`,
    signedBody: (o: {
      signer: string;
      file: string;
      signed: number;
      total: number;
      url: string;
    }) =>
      `${o.signer} signed the document "${o.file}".\n\n` +
      `Progress: ${o.signed}/${o.total} signers.\n\n` +
      `Follow the progress here:\n${o.url}\n\n`,
    rejectedSubject: (file: string) => `Signature declined - ${file}`,
    rejectedBody: (signer: string, file: string, reason?: string | null) =>
      `${signer} declined to sign the document "${file}".\n\n` +
      (reason ? `Reason: ${reason}\n\n` : "") +
      `The signature request has been cancelled.`,
    cancelledSubject: (file: string) => `Signature cancelled - ${file}`,
    cancelledBody: (file: string) =>
      `The signature request for the document "${file}" was cancelled by the sender.`,
    failedSubject: (file: string) => `Finalization error - ${file}`,
    failedBody: (file: string, url: string) =>
      `The automatic finalization of the document "${file}" failed.\n` +
      `All signatures were collected but the document could not be finalized.\n\n` +
      `You can try again from:\n${url}\n\n` +
      `If the problem persists, contact support.\n\n`,
    signerLine: (signer: string, signedAt: string) =>
      `  - ${signer} - signed on ${signedAt}`,
    completedCreatorSubject: (file: string) =>
      `Document signed by every signer - ${file}`,
    completedCreatorBody: (o: {
      file: string;
      signers: string;
      url: string;
      team: boolean;
    }) =>
      `The document "${o.file}" was signed by every signer and successfully finalized.\n\n` +
      `Signers:\n${o.signers}\n\n` +
      `The PAdES cryptographic signature has been applied.\n\n` +
      `View and download the signed document here:\n${o.url}\n\n` +
      (o.team ? `This document is also visible in your team space.\n\n` : ""),
    completedSubject: (file: string) => `Document signed - ${file}`,
    completedBody: (o: {
      file: string;
      signers: string;
      url: string;
      account: boolean;
    }) =>
      `The document "${o.file}" was signed by every signer and the PAdES cryptographic signature has been applied.\n\n` +
      `Signers:\n${o.signers}\n\n` +
      (o.account
        ? `You can view and download the signed document from your space:\n${o.url}\n\n` +
          `This document also appears under "Received documents" in the Signature tab.\n\n`
        : `If you have a PrivCloud Sharing account, sign in to find this document under "Received documents".\n\n`),
  },
};

export function signingMails(language: SigningLanguage) {
  return mails[language];
}
