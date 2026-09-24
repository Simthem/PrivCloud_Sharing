import * as crypto from "crypto";

export const SIGNING_TRANSACTION_PROTOCOL = "privcloud-signing-transaction-v2";
export const SIGNING_CHALLENGE_DOMAIN = "PrivCloud-Signature-v2";
export const EVIDENCE_BUNDLE_FORMAT = "privcloud-evidence-attestation-v1";
export const SIGNING_SOURCE_ATTACHMENT_NAME = "privcloud-source.pdf";
export const SIGNING_CONSENT_VERSION = "privcloud-explicit-consent-v1";
export const SIGNING_CONSENT_TEXT =
  "Je confirme avoir examiné le document identifié et consens expressément à le signer. / I confirm that I reviewed the identified document and expressly consent to sign it.";

export type SigningAction = "SIGN" | "REJECT";

export type SigningTransactionManifest = {
  protocol: typeof SIGNING_TRANSACTION_PROTOCOL;
  action: SigningAction;
  documentId: string;
  recipientId: string;
  signerAccountId: string;
  documentSha256: string;
  storageObjectSha256: string | null;
  requestExpiresAt: string | null;
  signatureType: string | null;
  signatureDataSha256: string | null;
  fieldValues: { fieldId: string; value: string }[];
  rejectionReason: string | null;
  consent: { version: string; text: string; textSha256: string };
};

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizedValue(child)]),
    );
  }
  return value;
}

/** RFC-8785-style deterministic JSON for the JSON values used by evidence. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedValue(value));
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildSigningTransactionManifest(input: {
  action: SigningAction;
  documentId: string;
  recipientId: string;
  signerAccountId: string;
  sourceDocumentHash: string;
  storageDocumentHash?: string;
  expiresAt: Date | null;
  signatureData?: string;
  signatureType?: string;
  fieldValues?: { fieldId: string; value: string }[];
  reason?: string;
}): SigningTransactionManifest {
  return {
    protocol: SIGNING_TRANSACTION_PROTOCOL,
    action: input.action,
    documentId: input.documentId,
    recipientId: input.recipientId,
    signerAccountId: input.signerAccountId,
    documentSha256: input.sourceDocumentHash,
    storageObjectSha256: input.storageDocumentHash || null,
    requestExpiresAt: input.expiresAt?.toISOString() || null,
    signatureType: input.signatureType || null,
    signatureDataSha256:
      input.signatureData === undefined ? null : sha256Hex(input.signatureData),
    fieldValues: [...(input.fieldValues || [])]
      .map(({ fieldId, value }) => ({ fieldId, value }))
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
    rejectionReason: input.reason?.trim() || null,
    consent:
      input.action === "SIGN"
        ? {
            version: SIGNING_CONSENT_VERSION,
            text: SIGNING_CONSENT_TEXT,
            textSha256: sha256Hex(SIGNING_CONSENT_TEXT),
          }
        : {
            version: "privcloud-explicit-rejection-v1",
            text: SIGNING_REJECTION_TEXT,
            textSha256: sha256Hex(SIGNING_REJECTION_TEXT),
          },
  };
}

export function hashSigningTransactionManifest(
  manifest: SigningTransactionManifest,
): string {
  return sha256Hex(canonicalJson(manifest));
}

/**
 * The random nonce prevents replay while the stored manifest and nonce let an
 * independent verifier reconstruct the exact challenge years later.
 */
export function buildTransactionChallenge(
  manifestHashHex: string,
  nonceBase64Url: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(manifestHashHex)) {
    throw new Error("manifestHashHex must be a lowercase SHA-256 digest");
  }
  const nonce = Buffer.from(nonceBase64Url, "base64url");
  if (nonce.length !== 32) throw new Error("challenge nonce must be 32 bytes");
  return crypto
    .createHash("sha256")
    .update(SIGNING_CHALLENGE_DOMAIN, "utf8")
    .update(Buffer.from([0]))
    .update(Buffer.from(manifestHashHex, "hex"))
    .update(nonce)
    .digest("base64url");
}

/** Raw bytes of a transaction challenge, as handed to the WebAuthn ceremony. */
export function transactionChallengeBytes(
  challengeBase64Url: string,
): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(challengeBase64Url, "base64url");
  const bytes = new Uint8Array(decoded.length);
  bytes.set(decoded);
  return bytes;
}

export function parseAuthenticatorEvidence(response: {
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}) {
  const authData = Buffer.from(response.response.authenticatorData, "base64url");
  if (authData.length < 37) throw new Error("Authenticator data is truncated");
  const flags = authData[32];
  return {
    clientDataJSON: response.response.clientDataJSON,
    authenticatorData: response.response.authenticatorData,
    signature: response.response.signature,
    userHandle: response.response.userHandle || null,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backupState: (flags & 0x10) !== 0,
    signCount: authData.readUInt32BE(33),
  };
}

export type SignerContribution = {
  signatureType: string | null;
  signatureDataSha256: string | null;
  fieldValues: { fieldId: string; value: string }[];
};

/** What the final PDF applies for one signer, in manifest form. */
export function buildSignerContribution(input: {
  signatureType: string | null;
  signatureData: string | null;
  fieldValues: { fieldId: string; value: string }[];
}): SignerContribution {
  return {
    signatureType: input.signatureType || null,
    signatureDataSha256:
      input.signatureData === null ? null : sha256Hex(input.signatureData),
    fieldValues: [...input.fieldValues]
      .map(({ fieldId, value }) => ({ fieldId, value }))
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
  };
}

/**
 * Checks that the contribution applied to the final PDF is exactly the one the
 * signer approved with WebAuthn, for the given source document.
 */
export function reconcileSignerContribution(input: {
  manifestJson: string;
  signingIntentHash: string | null;
  documentId: string;
  recipientId: string;
  signerAccountId: string | null;
  sourceSha256: string;
  contribution: SignerContribution;
}): string[] {
  const problems: string[] = [];
  let manifest: SigningTransactionManifest;
  try {
    manifest = JSON.parse(input.manifestJson);
  } catch {
    return ["the signed manifest is not valid JSON"];
  }
  if (canonicalJson(manifest) !== input.manifestJson) {
    problems.push("the signed manifest is not canonical");
  }
  if (hashSigningTransactionManifest(manifest) !== input.signingIntentHash) {
    problems.push("the signed manifest does not match the recorded intent hash");
  }
  if (manifest.action !== "SIGN") problems.push("the signed action is not SIGN");
  if (manifest.documentId !== input.documentId) {
    problems.push("the signed manifest names another document");
  }
  if (manifest.recipientId !== input.recipientId) {
    problems.push("the signed manifest names another recipient");
  }
  if (manifest.signerAccountId !== input.signerAccountId) {
    problems.push("the signed manifest names another account");
  }
  if (manifest.documentSha256 !== input.sourceSha256) {
    problems.push("the signer approved another source document");
  }
  if (manifest.signatureType !== input.contribution.signatureType) {
    problems.push("the applied signature type differs from the signed one");
  }
  if (manifest.signatureDataSha256 !== input.contribution.signatureDataSha256) {
    problems.push("the applied signature image differs from the signed one");
  }
  if (
    canonicalJson(manifest.fieldValues) !==
    canonicalJson(input.contribution.fieldValues)
  ) {
    problems.push("the applied field values differ from the signed ones");
  }
  return problems;
}

export const SIGNER_FORENSIC_RECORD_FORMAT =
  "privcloud-signer-forensic-record-v1";
export const SIGNING_REJECTION_TEXT =
  "Je refuse expressément le document identifié. / I expressly reject the identified document.";
export const RECORDED_IN_FORENSIC_EVIDENCE = "recorded-in-forensic-evidence";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Random, identity-independent identifier such as PCS-4B7D-A821-9QXM-T0KE. */
export function generateEvidenceId(): string {
  const characters = [...crypto.randomBytes(16)]
    .map((byte) => CROCKFORD_BASE32[byte & 31])
    .join("");
  return `PCS-${characters.match(/.{4}/g)!.join("-")}`;
}

export function consentSha256For(action: SigningAction): string {
  return sha256Hex(
    action === "SIGN" ? SIGNING_CONSENT_TEXT : SIGNING_REJECTION_TEXT,
  );
}

type RecipientEvidenceColumns = {
  authenticationMethod: string | null;
  signingIntentHash: string | null;
  signedDocumentHash: string | null;
  webauthnCredentialId?: string | null;
  webauthnPublicKey?: string | null;
  webauthnAlgorithm?: number | null;
  webauthnChallenge?: string | null;
  webauthnChallengeNonce?: string | null;
  webauthnTransactionManifest?: string | null;
  webauthnOrigin?: string | null;
  webauthnRpId?: string | null;
  webauthnSignCount?: bigint | null;
  webauthnClientDataJSON?: string | null;
  webauthnAuthenticatorData?: string | null;
  webauthnSignature?: string | null;
  webauthnUserHandle?: string | null;
  webauthnUserPresent?: boolean | null;
  webauthnUserVerified?: boolean | null;
  webauthnBackupEligible?: boolean | null;
  webauthnBackedUp?: boolean | null;
  webauthnDeviceType?: string | null;
  webauthnEnrollmentRecord?: string | null;
  webauthnEnrollmentSignature?: string | null;
};

/** Structured authentication evidence rebuilt from the persisted columns. */
export function signerAuthenticationEvidence(
  recipient: RecipientEvidenceColumns,
) {
  return {
    method: recipient.authenticationMethod,
    intentSha256: recipient.signingIntentHash,
    documentSha256: recipient.signedDocumentHash,
    transaction: recipient.webauthnTransactionManifest
      ? {
          manifest: JSON.parse(recipient.webauthnTransactionManifest),
          manifestSha256: recipient.signingIntentHash,
          nonceBase64Url: recipient.webauthnChallengeNonce ?? null,
          challengeBase64Url: recipient.webauthnChallenge ?? null,
        }
      : null,
    webauthn:
      recipient.authenticationMethod === "WEBAUTHN"
        ? {
            credentialId: recipient.webauthnCredentialId ?? null,
            publicKeyCoseBase64Url: recipient.webauthnPublicKey ?? null,
            publicKeyAlgorithm: recipient.webauthnAlgorithm ?? null,
            clientDataJSONBase64Url: recipient.webauthnClientDataJSON ?? null,
            authenticatorDataBase64Url:
              recipient.webauthnAuthenticatorData ?? null,
            signatureBase64Url: recipient.webauthnSignature ?? null,
            userHandleBase64Url: recipient.webauthnUserHandle ?? null,
            origin: recipient.webauthnOrigin ?? null,
            rpId: recipient.webauthnRpId ?? null,
            userPresent: recipient.webauthnUserPresent ?? null,
            userVerified: recipient.webauthnUserVerified ?? null,
            backupEligible: recipient.webauthnBackupEligible ?? null,
            backupState: recipient.webauthnBackedUp ?? null,
            signCount: recipient.webauthnSignCount?.toString() ?? null,
            deviceType: recipient.webauthnDeviceType ?? null,
            enrollmentRecord: recipient.webauthnEnrollmentRecord
              ? JSON.parse(recipient.webauthnEnrollmentRecord)
              : null,
            enrollmentSignatureCmsBase64:
              recipient.webauthnEnrollmentSignature ?? null,
          }
        : null,
  };
}

/**
 * Freezes, at the moment of the action, everything that attributes it to the
 * signer. The record stays internal to PrivCloud. The random salt makes its
 * hash, which is distributed, useless for guessing any identifier it holds.
 */
export function buildSignerForensicRecord(input: {
  evidenceId: string;
  documentId: string;
  recipientId: string;
  action: SigningAction;
  actedAt: Date;
  signer: {
    name: string;
    email: string;
    role: string;
    privcloudUserId: string | null;
  };
  identity: {
    verificationMethod: string | null;
    verifiedAt: Date | null;
    accountSnapshot: string | null;
  };
  network: { ipAddress: string | null; userAgent: string | null };
  evidence: RecipientEvidenceColumns;
}): { record: string; sha256: string } {
  const record = canonicalJson({
    format: SIGNER_FORENSIC_RECORD_FORMAT,
    evidenceId: input.evidenceId,
    salt: crypto.randomBytes(32).toString("base64url"),
    documentId: input.documentId,
    recipientId: input.recipientId,
    action: input.action,
    actedAt: input.actedAt.toISOString(),
    consentSha256: consentSha256For(input.action),
    signer: input.signer,
    identity: {
      verificationMethod: input.identity.verificationMethod,
      verifiedAt: input.identity.verifiedAt?.toISOString() || null,
      accountSnapshot: input.identity.accountSnapshot
        ? JSON.parse(input.identity.accountSnapshot)
        : null,
    },
    network: input.network,
    authentication: signerAuthenticationEvidence(input.evidence),
  });
  return { record, sha256: sha256Hex(record) };
}
