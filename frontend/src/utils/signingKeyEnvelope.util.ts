import {
  decryptNotificationMetadata,
  encryptNotificationMetadata,
  type UserPublicKeys,
} from "../services/crypto.service";
import { ContentIntegrityError } from "./contentV2.util";
import { importKeyFromBase64 } from "./crypto.util";

export type SigningKeyContext = {
  documentId: string;
  fileId: string;
  recipientUserId: string;
};

export async function sealSigningKey(
  key: string,
  context: SigningKeyContext,
  recipient: UserPublicKeys,
): Promise<string> {
  if (
    !recipient.x25519 ||
    recipient.userId !== context.recipientUserId ||
    !/^[A-Za-z0-9_-]{43}$/.test(key)
  ) {
    throw new ContentIntegrityError("Invalid signing key recipient");
  }
  await importKeyFromBase64(key);
  const pq =
    recipient.pqKey &&
    (recipient.pqKey.variant ?? "ML-KEM-768") === "ML-KEM-768"
      ? recipient.pqKey.publicKey
      : null;
  return encryptNotificationMetadata(
    { purpose: "SIGNING_KEY_V1", ...context, key },
    recipient.x25519.publicKey,
    pq,
  );
}

// Completed results keep their document binding after the source File is deleted.
export async function openSigningKey(
  envelope: string,
  context: Omit<SigningKeyContext, "fileId"> & { fileId: string | null },
  masterKey: CryptoKey,
): Promise<string> {
  const payload = await decryptNotificationMetadata(envelope, masterKey);
  if (
    !payload ||
    payload.purpose !== "SIGNING_KEY_V1" ||
    payload.documentId !== context.documentId ||
    typeof payload.fileId !== "string" ||
    (context.fileId !== null && payload.fileId !== context.fileId) ||
    payload.recipientUserId !== context.recipientUserId ||
    typeof payload.key !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.key)
  ) {
    throw new ContentIntegrityError("Invalid signing key envelope context");
  }
  await importKeyFromBase64(payload.key);
  return payload.key;
}
