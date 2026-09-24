type Sha256Hex = (_bytes: Uint8Array) => Promise<string>;

export type FinalizationSigner = {
  id: string;
  name: string;
  userId?: string | null;
  signatureType?: string | null;
  signatureData?: string | null;
  signingIntentHash?: string | null;
  webauthnTransactionManifest?: string | null;
};

export type FinalizationFieldValue = {
  fieldId: string;
  recipientId: string;
  value: string;
};

const normalized = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalized(child)]),
    );
  }
  return value;
};

/** Same deterministic JSON as the backend evidence manifests. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalized(value));

const utf8 = (value: string) => new TextEncoder().encode(value);

/**
 * Rebuilds, in the requester's browser, what the final PDF will apply for
 * each signer and returns every difference with the manifest that signer
 * approved through WebAuthn. An empty list means the PDF may be sealed.
 */
export const reconcileSignerContributions = async (input: {
  documentId: string;
  sourceSha256: string;
  signers: FinalizationSigner[];
  fieldValues: FinalizationFieldValue[];
  sha256Hex: Sha256Hex;
}): Promise<string[]> => {
  const problems: string[] = [];
  for (const signer of input.signers) {
    // Signed before manifests were persisted, nothing to reconcile.
    if (!signer.webauthnTransactionManifest) continue;
    const report = (problem: string) =>
      problems.push(`${signer.name}: ${problem}`);
    let manifest: any;
    try {
      manifest = JSON.parse(signer.webauthnTransactionManifest);
    } catch {
      report("the signed manifest is not valid JSON");
      continue;
    }
    const manifestJson = canonicalJson(manifest);
    if (manifestJson !== signer.webauthnTransactionManifest) {
      report("the signed manifest is not canonical");
    }
    if ((await input.sha256Hex(utf8(manifestJson))) !== signer.signingIntentHash) {
      report("the signed manifest does not match the recorded intent hash");
    }
    if (manifest.action !== "SIGN") report("the signed action is not SIGN");
    if (manifest.documentId !== input.documentId) {
      report("the signed manifest names another document");
    }
    if (manifest.recipientId !== signer.id) {
      report("the signed manifest names another recipient");
    }
    if (manifest.signerAccountId !== (signer.userId ?? null)) {
      report("the signed manifest names another account");
    }
    if (manifest.documentSha256 !== input.sourceSha256) {
      report("the signer approved another source document");
    }
    if (manifest.signatureType !== (signer.signatureType || null)) {
      report("the applied signature type differs from the signed one");
    }
    const signatureDataSha256 =
      signer.signatureData === null || signer.signatureData === undefined
        ? null
        : await input.sha256Hex(utf8(signer.signatureData));
    if (manifest.signatureDataSha256 !== signatureDataSha256) {
      report("the applied signature image differs from the signed one");
    }
    const applied = input.fieldValues
      .filter((entry) => entry.recipientId === signer.id)
      .map(({ fieldId, value }) => ({ fieldId, value }))
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
    if (canonicalJson(manifest.fieldValues) !== canonicalJson(applied)) {
      report("the applied field values differ from the signed ones");
    }
  }
  return problems;
};
