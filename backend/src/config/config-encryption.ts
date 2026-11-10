import { InternalServerErrorException, Logger } from "@nestjs/common";
import type { Config } from "@prisma/client";
import * as crypto from "crypto";
import * as fs from "fs";

export const SEALED_PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const ENCRYPTED_SETTINGS = new Set([
  "internal.jwtSecret",
  "cache.redis-url",
  "email.tsaCheckRecipient",
  "email.quoteRequestRecipient",
  "smtp.host",
  "smtp.email",
  "smtp.username",
  "smtp.password",
  "smtp.generalEmail",
  "smtp.generalHost",
  "smtp.generalUsername",
  "smtp.generalPassword",
  "ldap.url",
  "ldap.bindDn",
  "ldap.bindPassword",
  "ldap.searchBase",
  "ldap.searchQuery",
  "ldap.adminGroups",
  "oauth.github-clientId",
  "oauth.github-clientSecret",
  "oauth.google-clientId",
  "oauth.google-clientSecret",
  "oauth.microsoft-tenant",
  "oauth.microsoft-clientId",
  "oauth.microsoft-clientSecret",
  "oauth.discord-limitedGuild",
  "oauth.discord-limitedUsers",
  "oauth.discord-clientId",
  "oauth.discord-clientSecret",
  "oauth.oidc-discoveryUri",
  "oauth.oidc-clientId",
  "oauth.oidc-clientSecret",
  "s3.endpoint",
  "s3.region",
  "s3.bucketName",
  "s3.bucketPath",
  "s3.key",
  "s3.secret",
  "pushNotifications.vapidPrivateKey",
  "altcha.hmacKey",
  "signing.certificatePassword",
]);

type ConfigStore = {
  config: {
    findMany: () => Promise<Config[]>;
    updateMany: (args: {
      where: { category: string; name: string; value: string };
      data: { value: string };
    }) => Promise<unknown>;
  };
};

const settingId = (category: string, name: string) => `${category}.${name}`;

export const isSealedValue = (value: string | null) =>
  !!value?.startsWith(SEALED_PREFIX);

export const isEncryptedSetting = (category: string, name: string) =>
  ENCRYPTED_SETTINGS.has(settingId(category, name));

/** Null when no key is configured: settings then stay as they are stored. */
export function loadConfigKey(): Buffer | null {
  const file = process.env.CONFIG_ENCRYPTION_KEY_FILE?.trim();
  if (!file) return null;
  let key: Buffer;
  try {
    key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  } catch {
    throw new InternalServerErrorException(
      "CONFIG_ENCRYPTION_KEY_FILE cannot be read",
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new InternalServerErrorException(
      "CONFIG_ENCRYPTION_KEY_FILE must hold 32 bytes encoded in base64",
    );
  }
  return key;
}

/** Rolling back to a version without encryption needs plaintext rows again. */
export const isDecryptMode = () =>
  process.env.CONFIG_ENCRYPTION_MODE?.trim() === "decrypt";

export function sealValue(
  key: Buffer,
  category: string,
  name: string,
  value: string,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(settingId(category, name), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return (
    SEALED_PREFIX +
    [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString("base64url"))
      .join(".")
  );
}

export function openValue(
  key: Buffer | null,
  category: string,
  name: string,
  value: string,
): string {
  if (!isSealedValue(value)) return value;
  if (!key) {
    throw new InternalServerErrorException(
      "Encrypted settings found: CONFIG_ENCRYPTION_KEY_FILE is required",
    );
  }
  try {
    const [iv, tag, ciphertext] = value
      .slice(SEALED_PREFIX.length)
      .split(".")
      .map((part) => Buffer.from(part, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(settingId(category, name), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new InternalServerErrorException(
      "An encrypted setting cannot be opened with CONFIG_ENCRYPTION_KEY_FILE",
    );
  }
}

export const openRows = (rows: Config[], key: Buffer | null): Config[] =>
  rows.map((row) =>
    row.value === null
      ? row
      : { ...row, value: openValue(key, row.category, row.name, row.value) },
  );

/**
 * Brings the stored secrets in line with the configured key. Each write is
 * guarded by the value it read, so concurrent replicas cannot undo an edit.
 */
export async function applyConfigEncryption(
  store: ConfigStore,
  key: Buffer | null,
  logger = new Logger("ConfigEncryption"),
) {
  if (!key) return;
  const decrypting = isDecryptMode();
  let changed = 0;
  for (const row of await store.config.findMany()) {
    if (!row.value || !isEncryptedSetting(row.category, row.name)) continue;
    const sealed = isSealedValue(row.value);
    if (sealed !== decrypting) continue;
    await store.config.updateMany({
      where: { category: row.category, name: row.name, value: row.value },
      data: {
        value: decrypting
          ? openValue(key, row.category, row.name, row.value)
          : sealValue(key, row.category, row.name, row.value),
      },
    });
    changed++;
  }
  if (changed > 0) {
    logger.log(`${decrypting ? "Decrypted" : "Encrypted"} ${changed} settings`);
  }
}
