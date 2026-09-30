import * as crypto from "crypto";

export type RefreshReplayTokens = {
  accessToken: string;
  refreshToken: string;
};

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(secret: string): Buffer {
  return crypto
    .createHash("sha256")
    .update("privcloud-refresh-replay-v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

export function encryptRefreshReplay(
  tokens: RefreshReplayTokens,
  secret: string,
): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptRefreshReplay(
  envelope: string,
  secret: string,
): RefreshReplayTokens {
  const [version, ivText, tagText, ciphertextText, extra] = envelope.split(".");
  if (
    version !== VERSION ||
    !ivText ||
    !tagText ||
    !ciphertextText ||
    extra !== undefined
  ) {
    throw new Error("Invalid refresh replay envelope");
  }

  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  if (
    iv.length !== IV_BYTES ||
    tag.length !== TAG_BYTES ||
    !ciphertext.length
  ) {
    throw new Error("Invalid refresh replay envelope");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    iv,
  );
  decipher.setAuthTag(tag);
  const decoded = JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    ),
  ) as Partial<RefreshReplayTokens>;

  if (
    typeof decoded.accessToken !== "string" ||
    !decoded.accessToken ||
    typeof decoded.refreshToken !== "string" ||
    !decoded.refreshToken
  ) {
    throw new Error("Invalid refresh replay payload");
  }
  return {
    accessToken: decoded.accessToken,
    refreshToken: decoded.refreshToken,
  };
}
