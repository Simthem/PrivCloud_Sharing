// Wording of the evidence dossier appended to a signed PDF, in the
// requester's language.

import { SigningLanguage } from "./signing-language";

type DossierText = {
  title: string;
  subtitle: (reinforced: boolean) => string;
  documentSection: string;
  documentId: string;
  file: string;
  level: (reinforced: boolean) => string;
  contentHash: string;
  finalHash: string;
  finalizedAt: string;
  signersSection: string;
  signer: (index: number) => string;
  name: string;
  email: string;
  evidenceId: string;
  ipAddress: string;
  signedAt: string;
  signatureType: string;
  authentication: string;
  attribution: (account: boolean) => string;
  verification: (account: boolean) => string;
  webauthnVerified: string;
  transactionBound: string;
  sourceHash: string;
  consentHash: string;
  intentHash: string;
  forensicHash: string;
  authenticationMethod: Record<string, string>;
  verificationMethod: Record<string, string>;
  legalSection: string;
  legalReinforced: string[];
  legalStandard: string[];
  legalIntro: string[];
  legalOutro: string[];
  footer: (
    generatedAt: string,
    page?: { index: number; count: number },
  ) => string;
};

const french: DossierText = {
  title: "DOSSIER DE PREUVE DE SIGNATURE ÉLECTRONIQUE",
  subtitle: (reinforced: boolean) =>
    reinforced
      ? "Niveau renforcé - compte attribué et confirmation WebAuthn"
      : "Niveau standard - contrôle de l'adresse e-mail et consentement",
  documentSection: "INFORMATIONS DU DOCUMENT",
  documentId: "Identifiant",
  file: "Fichier",
  level: (reinforced: boolean) =>
    `Niveau de preuve: ${reinforced ? "Renforcé - compte vérifié + passkey" : "Standard - code e-mail + consentement"}`,
  contentHash:
    "Empreinte du contenu signé (avant page de preuve et scellement)",
  finalHash:
    "Empreinte du fichier PDF final: figure dans l'attestation de preuve, un fichier ne pouvant contenir sa propre empreinte",
  finalizedAt: "Date de finalisation",
  signersSection: "SIGNATAIRES",
  signer: (index: number) => `Signataire ${index}:`,
  name: "Nom",
  email: "Email",
  evidenceId: "Identifiant de preuve",
  ipAddress: "Adresse IP: enregistrée dans le dossier probatoire",
  signedAt: "Signé le",
  signatureType: "Type de signature",
  authentication: "Authentification",
  attribution: (account: boolean) =>
    account
      ? "Attribution du signataire: compte PrivCloud attribué"
      : "Attribution du signataire: destinataire désigné par son adresse e-mail",
  verification: (account: boolean) =>
    account ? "Vérification du compte" : "Vérification de l'adresse",
  webauthnVerified: "Vérification locale WebAuthn: oui",
  transactionBound: "Transaction liée au document: vérifiée",
  sourceHash: "Empreinte du document source approuvé",
  consentHash: "Empreinte du texte de consentement",
  intentHash: "Empreinte du manifeste de transaction",
  forensicHash: "Empreinte du dossier probatoire",
  authenticationMethod: {
    EMAIL_OTP_CONSENT: "Code e-mail à usage unique + consentement",
    WEBAUTHN: "Passkey WebAuthn liée à la transaction",
    none: "Méthode non enregistrée",
  },
  verificationMethod: {
    EMAIL_OTP: "Contrôle de l'adresse e-mail par code à usage unique",
    VERIFIED_EMAIL_ACCOUNT: "Adresse e-mail vérifiée par lien de confirmation",
    ADMIN_VERIFIED_EMAIL_ACCOUNT:
      "Adresse e-mail vérifiée par un administrateur",
    LDAP_ACCOUNT: "Identité fournie par l'annuaire LDAP",
    OIDC_ACCOUNT: "Identité fournie par le fournisseur OIDC",
    none: "Aucune vérification enregistrée",
  },
  legalSection: "MENTION LÉGALE",
  legalReinforced: [
    "Le profil renforcé de PrivCloud met en œuvre une signature électronique avancée conformément aux",
    "exigences de l'article 26 du règlement eIDAS. Elle repose sur une assertion WebAuthn transactionnelle",
    "et s'accompagne d'un scellement cryptographique CMS/PDF du dossier de preuve apposé par PrivCloud.",
    "Chaque décision fait l'objet d'une assertion WebAuthn dont le challenge est dérivé d'un manifeste",
    "liant le compte attribué, le consentement et l'empreinte exacte du document. La clé WebAuthn est",
    "rattachée au compte par une preuve d'enrôlement signée. L'assertion brute, la clé publique et les",
    "données réseau sont conservées dans un dossier probatoire scellé, communiqué en cas de contestation",
    "et vérifiable hors ligne grâce aux empreintes ci-dessus. Il ne s'agit ni d'une identité civile",
    "qualifiée, ni d'une signature électronique qualifiée (QES).",
  ],
  legalStandard: [
    "Le niveau standard exige un code à usage unique envoyé à l'adresse e-mail attribuée avant",
    "la décision. Cette preuve établit le contrôle actuel de la boîte, pas l'identité civile de la",
    "personne qui saisit le code ni une maîtrise personnelle exclusive et durable de cette adresse.",
    "Le consentement est lié à l'empreinte du document. PrivCloud ne présente pas ce parcours comme",
    "une signature avancée conforme à l'article 26, ni comme une signature électronique qualifiée.",
  ],
  legalIntro: [
    "Le règlement eIDAS interdit de refuser l'effet juridique ou l'admissibilité d'une signature",
    "au seul motif de sa forme électronique ou de son caractère non qualifié (article 25, paragraphe 1).",
  ],
  legalOutro: [
    "Le fichier final comporte une signature CMS/PDF du serveur destinée à détecter toute modification.",
    "Cette signature technique du serveur n'est pas la signature personnelle du signataire.",
    "La piste d'audit est chaînée par SHA-256 à compter de l'activation de cette fonctionnalité.",
    "Les adresses IP et identifiants techniques, conservés pour établir la preuve et prévenir la fraude,",
    "ne sont pas diffusés aux parties. Chaque signataire peut obtenir les données qui le concernent.",
    "Lorsque l'horodatage est activé, seule l'empreinte SHA-256 de la valeur de signature est",
    "soumise à la TSA. La réponse RFC 3161 (empreinte, nonce, heure, signature et certificat TSA)",
    "est vérifiée avant que son jeton cryptographique soit incorporé au CMS/PDF, le document n'est",
    "alors finalisé que si ce jeton est valide, sauf dérogation serveur explicitement configurée.",
    "",
    "Le caractère qualifié de l'horodatage dépend du service TSA et du certificat effectivement employés,",
    "tels qu'inscrits dans la Trusted List applicable. Il ne résulte pas du seul protocole RFC 3161.",
  ],
  footer: (generatedAt: string, page?: { index: number; count: number }) =>
    page
      ? `Généré par PrivCloud Sharing - ${generatedAt} - page ${page.index}/${page.count}`
      : `Généré par PrivCloud Sharing - ${generatedAt}`,
};

const english: DossierText = {
  title: "ELECTRONIC SIGNATURE EVIDENCE DOSSIER",
  subtitle: (reinforced: boolean) =>
    reinforced
      ? "Reinforced level - assigned account and WebAuthn confirmation"
      : "Standard level - e-mail address control and consent",
  documentSection: "DOCUMENT INFORMATION",
  documentId: "Identifier",
  file: "File",
  level: (reinforced: boolean) =>
    `Evidence level: ${reinforced ? "Reinforced - verified account + passkey" : "Standard - e-mail code + consent"}`,
  contentHash: "Hash of the signed content (before evidence page and sealing)",
  finalHash:
    "Hash of the final PDF file: given in the evidence attestation, as a file cannot contain its own hash",
  finalizedAt: "Finalization date",
  signersSection: "SIGNERS",
  signer: (index: number) => `Signer ${index}:`,
  name: "Name",
  email: "Email",
  evidenceId: "Evidence identifier",
  ipAddress: "IP address: recorded in the forensic dossier",
  signedAt: "Signed on",
  signatureType: "Signature type",
  authentication: "Authentication",
  attribution: (account: boolean) =>
    account
      ? "Signer attribution: assigned PrivCloud account"
      : "Signer attribution: recipient designated by e-mail address",
  verification: (account: boolean) =>
    account ? "Account verification" : "Address verification",
  webauthnVerified: "Local WebAuthn user verification: yes",
  transactionBound: "Transaction bound to the document: verified",
  sourceHash: "Hash of the approved source document",
  consentHash: "Hash of the consent text",
  intentHash: "Hash of the transaction manifest",
  forensicHash: "Hash of the forensic dossier",
  authenticationMethod: {
    EMAIL_OTP_CONSENT: "One-time e-mail code + consent",
    WEBAUTHN: "WebAuthn passkey bound to the transaction",
    none: "Method not recorded",
  },
  verificationMethod: {
    EMAIL_OTP: "E-mail address control by one-time code",
    VERIFIED_EMAIL_ACCOUNT: "E-mail address verified by confirmation link",
    ADMIN_VERIFIED_EMAIL_ACCOUNT: "E-mail address verified by an administrator",
    LDAP_ACCOUNT: "Identity provided by the LDAP directory",
    OIDC_ACCOUNT: "Identity provided by the OIDC provider",
    none: "No verification recorded",
  },
  legalSection: "LEGAL NOTICE",
  legalReinforced: [
    "The PrivCloud reinforced profile implements an advanced electronic signature in line with the",
    "requirements of Article 26 of the eIDAS Regulation. It relies on a transactional WebAuthn assertion",
    "and comes with a CMS/PDF cryptographic seal of the evidence dossier applied by PrivCloud.",
    "Each decision is backed by a WebAuthn assertion whose challenge is derived from a manifest",
    "binding the assigned account, the consent and the exact hash of the document. The WebAuthn key is",
    "bound to the account by a signed enrolment proof. The raw assertion, the public key and the",
    "network data are kept in a sealed forensic dossier, disclosed in the event of a dispute",
    "and verifiable offline with the hashes above. This is neither a qualified civil identity",
    "nor a qualified electronic signature (QES).",
  ],
  legalStandard: [
    "The standard level requires a one-time code sent to the assigned e-mail address before",
    "the decision. This proof establishes current control of the mailbox, not the civil identity of the",
    "person entering the code, nor exclusive and lasting personal control of that address.",
    "Consent is bound to the hash of the document. PrivCloud does not present this flow as",
    "an advanced signature under Article 26, nor as a qualified electronic signature.",
  ],
  legalIntro: [
    "The eIDAS Regulation forbids denying the legal effect or admissibility of a signature",
    "solely on the grounds that it is in electronic form or is not qualified (Article 25(1)).",
  ],
  legalOutro: [
    "The final file carries a CMS/PDF server signature intended to detect any modification.",
    "This technical server signature is not the personal signature of the signer.",
    "The audit trail is chained with SHA-256 from the activation of this feature onwards.",
    "IP addresses and technical identifiers, kept to establish evidence and prevent fraud,",
    "are not disclosed to the parties. Each signer can obtain the data that concerns them.",
    "When timestamping is enabled, only the SHA-256 hash of the signature value is",
    "submitted to the TSA. The RFC 3161 response (hash, nonce, time, TSA signature and certificate)",
    "is verified before its cryptographic token is embedded in the CMS/PDF. The document is",
    "then finalized only if this token is valid, unless a server exemption is explicitly configured.",
    "",
    "Whether the timestamp is qualified depends on the TSA service and certificate actually used,",
    "as listed in the applicable Trusted List. It does not follow from the RFC 3161 protocol alone.",
  ],
  footer: (generatedAt: string, page?: { index: number; count: number }) =>
    page
      ? `Generated by PrivCloud Sharing - ${generatedAt} - page ${page.index}/${page.count}`
      : `Generated by PrivCloud Sharing - ${generatedAt}`,
};

export function dossierText(language: SigningLanguage) {
  return language === "en" ? english : french;
}
