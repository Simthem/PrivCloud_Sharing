import * as crypto from "crypto";

export type OutboxEmail = {
  recipient: string;
  subject: string;
  text: string;
};

const VERSION = "v1";

function key(secret: string): Buffer {
  return crypto
    .createHash("sha256")
    .update("privcloud-email-outbox-v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

export function encryptOutboxEmail(
  message: OutboxEmail,
  secret: string,
  associatedKey: string,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(associatedKey, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(message), "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptOutboxEmail(
  envelope: string,
  secret: string,
  associatedKey: string,
): OutboxEmail {
  const [version, ivText, tagText, ciphertextText, extra] = envelope.split(".");
  if (
    version !== VERSION ||
    !ivText ||
    !tagText ||
    !ciphertextText ||
    extra !== undefined
  ) {
    throw new Error("Invalid email outbox envelope");
  }

  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
    throw new Error("Invalid email outbox envelope");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key(secret), iv);
  decipher.setAAD(Buffer.from(associatedKey, "utf8"));
  decipher.setAuthTag(tag);
  const decoded = JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    ),
  ) as Partial<OutboxEmail>;
  if (
    typeof decoded.recipient !== "string" ||
    !decoded.recipient ||
    typeof decoded.subject !== "string" ||
    !decoded.subject ||
    typeof decoded.text !== "string"
  ) {
    throw new Error("Invalid email outbox payload");
  }
  return {
    recipient: decoded.recipient,
    subject: decoded.subject,
    text: decoded.text,
  };
}
