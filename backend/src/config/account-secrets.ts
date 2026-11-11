import { InternalServerErrorException, Logger } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
} from "crypto";
import {
  isDecryptMode,
  loadConfigKey,
  openValue,
  sealValue,
  SEALED_PREFIX,
} from "./config-encryption";

type AccountSecret =
  | "totpSecret"
  | "oauthIDToken"
  | "providerUsername"
  | "verifiedEmail"
  | "p256dh"
  | "auth";

export type TokenKind =
  | "enrollment"
  | "invitation"
  | "guestLink"
  | "signing"
  | "reverseShare"
  | "pushEndpoint";

type Row = Record<string, string>;
type Table = {
  findMany: (args: {
    where: object;
    select: object;
    take: number;
  }) => Promise<Row[]>;
  updateMany: (args: {
    where: object;
    data: object;
  }) => Promise<{ count: number }>;
  deleteMany: (args: { where: object }) => Promise<unknown>;
};
type AccountStore = Pick<
  PrismaClient,
  | "user"
  | "refreshToken"
  | "oAuthUser"
  | "pushSubscription"
  | "enrollmentToken"
  | "teamInvitation"
  | "teamGuestLink"
  | "signatureRecipient"
  | "reverseShare"
>;

const SECRET_COLUMNS: {
  table: keyof AccountStore;
  field: AccountSecret;
  owner: string;
}[] = [
  { table: "user", field: "totpSecret", owner: "id" },
  { table: "refreshToken", field: "oauthIDToken", owner: "userId" },
  { table: "oAuthUser", field: "providerUsername", owner: "userId" },
  { table: "oAuthUser", field: "verifiedEmail", owner: "userId" },
  { table: "pushSubscription", field: "p256dh", owner: "userId" },
  { table: "pushSubscription", field: "auth", owner: "userId" },
];
const TOKEN_COLUMNS: {
  table: keyof AccountStore;
  field: string;
  kind: TokenKind;
}[] = [
  { table: "enrollmentToken", field: "token", kind: "enrollment" },
  { table: "teamInvitation", field: "token", kind: "invitation" },
  { table: "teamGuestLink", field: "token", kind: "guestLink" },
  { table: "signatureRecipient", field: "signingToken", kind: "signing" },
  { table: "reverseShare", field: "token", kind: "reverseShare" },
  { table: "pushSubscription", field: "endpoint", kind: "pushEndpoint" },
];

const modelOf = (table: string) => table[0].toUpperCase() + table.slice(1);

/** Link token columns by model, with the kind they are sealed under. */
export const TOKEN_FIELDS: Record<string, Record<string, TokenKind>> = {};
for (const { table, field, kind } of TOKEN_COLUMNS) {
  (TOKEN_FIELDS[modelOf(table)] ??= {})[field] = kind;
}

/** Account secret columns by model, with the column naming their owner. */
export const SECRET_FIELDS: Record<string, Record<string, string>> = {};
for (const { table, field, owner } of SECRET_COLUMNS) {
  (SECRET_FIELDS[modelOf(table)] ??= {})[field] = owner;
}

const BATCH_SIZE = 500;
const CATEGORY = "account";
export const TOKEN_PREFIX = "enc:d1:";

let loaded: { file: string | undefined; key: Buffer | null } | undefined;

function accountKey() {
  const file = process.env.CONFIG_ENCRYPTION_KEY_FILE;
  if (!loaded || loaded.file !== file) loaded = { file, key: loadConfigKey() };
  return loaded.key;
}

/** Older images cannot read these columns: sealing them is a separate step. */
export const isFullMode = () =>
  process.env.CONFIG_ENCRYPTION_MODE?.trim() === "full";

const accountSecretName = (userId: string, field: AccountSecret) =>
  `${userId}.${field}`;

export function sealAccountSecret(
  userId: string,
  field: AccountSecret,
  value: string,
) {
  const key = accountKey();
  return key && isFullMode()
    ? sealValue(key, CATEGORY, accountSecretName(userId, field), value)
    : value;
}

/** Equality index for a verified email claim, independent of credentials. */
export function verifiedEmailFold(email: string) {
  const key = accountKey();
  const input = `verified-email-fold\0${email.toLowerCase()}`;
  if (key) {
    return createHmac("sha256", key).update(input, "utf8").digest("base64url");
  }
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

export function openAccountSecret(
  userId: string,
  field: AccountSecret,
  value: string,
) {
  return openValue(
    accountKey(),
    CATEGORY,
    accountSecretName(userId, field),
    value,
  );
}

const tokenKeys = (key: Buffer) => {
  const derived = Buffer.from(hkdfSync("sha256", key, "", "stored-token", 64));
  return { cipher: derived.subarray(0, 32), mac: derived.subarray(32) };
};

function sealTokenWith(key: Buffer, kind: string, value: string) {
  const keys = tokenKeys(key);
  const iv = createHmac("sha256", keys.mac)
    .update(`${kind}\0${value}`, "utf8")
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", keys.cipher, iv);
  cipher.setAAD(Buffer.from(kind, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return (
    TOKEN_PREFIX +
    [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString("base64url"))
      .join(".")
  );
}

function openTokenWith(key: Buffer, kind: string, stored: string) {
  const [iv, tag, ciphertext] = stored
    .slice(TOKEN_PREFIX.length)
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    tokenKeys(key).cipher,
    iv,
  ).setAAD(Buffer.from(kind, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export const sealLookupValue = sealTokenWith;

/** A same value always seals alike, so that it can still be looked up. */
export function sealToken(kind: TokenKind, value: string) {
  const key = accountKey();
  return key && isFullMode() ? sealTokenWith(key, kind, value) : value;
}

export function openToken(kind: string, stored: string) {
  if (!stored.startsWith(TOKEN_PREFIX)) return stored;
  const key = accountKey();
  if (!key) {
    throw new InternalServerErrorException(
      "Encrypted tokens found: CONFIG_ENCRYPTION_KEY_FILE is required",
    );
  }
  return openTokenWith(key, kind, stored);
}

/**
 * The stored forms of a token presented by a client. A value read from the
 * database is no token: only what seals to a stored value opens a row.
 */
export function tokenCandidates(kind: TokenKind, presented: unknown) {
  if (typeof presented !== "string" || presented.startsWith("enc:")) return [];
  const key = accountKey();
  return key ? [sealTokenWith(key, kind, presented), presented] : [presented];
}

export async function findByToken<T>(
  kind: TokenKind,
  presented: unknown,
  find: (stored: string) => Promise<T | null>,
) {
  for (const stored of tokenCandidates(kind, presented)) {
    const row = await find(stored);
    if (row) return row;
  }
  return null;
}

const pending = (field: string, prefix: string, sealed: boolean) => {
  const stored = { [field]: { startsWith: prefix } };
  return sealed ? stored : { NOT: stored };
};

async function convertColumn(
  table: Table,
  field: string,
  where: object,
  select: object,
  convert: (row: Row) => string,
) {
  let changed = 0;
  for (;;) {
    const rows = await table.findMany({ where, select, take: BATCH_SIZE });
    if (rows.length === 0) return changed;
    for (const row of rows) {
      const guard = { id: row.id, [field]: row[field] };
      try {
        const { count } = await table.updateMany({
          where: guard,
          data: { [field]: convert(row) },
        });
        changed += count;
      } catch (error) {
        // The same token was stored in both forms: one row is enough.
        if ((error as { code?: string }).code !== "P2002") throw error;
        await table.deleteMany({ where: guard });
      }
    }
  }
}

/**
 * Brings stored account secrets in line with the mode. Each write is guarded
 * by the value it read, so concurrent replicas cannot undo a change.
 */
export async function applyAccountEncryption(
  store: AccountStore,
  key: Buffer | null,
  logger = new Logger("AccountEncryption"),
) {
  const decrypting = isDecryptMode();
  if (!key || (!decrypting && !isFullMode())) return;
  const tables = store as unknown as Record<string, Table>;

  let changed = 0;
  for (const { table, field, owner } of SECRET_COLUMNS) {
    changed += await convertColumn(
      tables[table],
      field,
      pending(field, SEALED_PREFIX, decrypting),
      { id: true, [owner]: true, [field]: true },
      (row) => {
        const name = accountSecretName(row[owner], field);
        return decrypting
          ? openValue(key, CATEGORY, name, row[field])
          : sealValue(key, CATEGORY, name, row[field]);
      },
    );
  }
  for (const { table, field, kind } of TOKEN_COLUMNS) {
    changed += await convertColumn(
      tables[table],
      field,
      pending(field, TOKEN_PREFIX, decrypting),
      { id: true, [field]: true },
      (row) =>
        decrypting
          ? openTokenWith(key, kind, row[field])
          : sealTokenWith(key, kind, row[field]),
    );
  }
  if (changed > 0) {
    logger.log(
      `${decrypting ? "Decrypted" : "Encrypted"} ${changed} account secrets`,
    );
  }
}
