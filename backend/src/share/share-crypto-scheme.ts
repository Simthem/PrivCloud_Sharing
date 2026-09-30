import * as crypto from "crypto";

/**
 * Personal share key schemes.
 *
 * LEGACY_ACCOUNT_KEY: files are encrypted directly with the owner's account
 * key K_master, and the recipient link carries K_master. Every row written
 * before `Share.cryptoScheme` existed holds NULL and uses this scheme.
 *
 * SHARE_DEK_V1: files are encrypted with a random AES-256-GCM key K_share
 * generated in the owner's browser for this share only. The recipient link
 * carries K_share. The server stores K_share wrapped by K_master and never
 * receives it in clear.
 *
 * Team shares (K_team) and reverse-share uploads (K_rs) keep their own key
 * resolution and are not described by this column.
 */
export const LEGACY_ACCOUNT_KEY = 1;
export const SHARE_DEK_V1 = 2;
export type ShareCryptoScheme = typeof LEGACY_ACCOUNT_KEY | typeof SHARE_DEK_V1;

export const SHARE_KEY_WRAP_ALGORITHM = "AES-256-GCM/K_MASTER/AAD-SHARE-ID/V1";

// [IV 12][K_share 32][GCM tag 16] = 60 bytes = 80 base64url characters.
export const WRAPPED_SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{80}$/;

export function resolveShareCryptoScheme(
  value: number | null | undefined,
): ShareCryptoScheme {
  if (value === null || value === undefined || value === LEGACY_ACCOUNT_KEY) {
    return LEGACY_ACCOUNT_KEY;
  }
  if (value === SHARE_DEK_V1) return SHARE_DEK_V1;
  throw new Error(`Unsupported share crypto scheme: ${value}`);
}

export function shareCryptoSchemeName(value: number | null | undefined) {
  try {
    return resolveShareCryptoScheme(value) === SHARE_DEK_V1
      ? "SHARE_DEK_V1"
      : "LEGACY_ACCOUNT_KEY";
  } catch {
    return "UNKNOWN";
  }
}

// ----- Feature flags ------------------------------------------------------
//
// SHARE_DEK_V1_READ (default true): the server accepts and serves the wrapped
//   key of SHARE_DEK_V1 shares. Setting it to false after such shares exist
//   leaves recipients unaffected but prevents their owners from opening them.
// SHARE_DEK_V1_WRITE (default false): new personal E2E shares may be created
//   with SHARE_DEK_V1, for the users selected below only.
// SHARE_DEK_V1_CANARY_USERS: comma-separated user ids or e-mail addresses,
//   or "*" for every user. Empty selects nobody, even with WRITE=true.
// SHARE_DEK_V1_ROLLOUT_PERCENT (0-100, default 0): additionally selects a
//   stable share of users, from a hash of their id.

type FlagEnv = Record<string, string | undefined>;

export function parseFlagBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isShareDekReadEnabled(env: FlagEnv = process.env) {
  return parseFlagBoolean(env.SHARE_DEK_V1_READ, true);
}

function rolloutBucket(salt: string, userId: string) {
  const digest = crypto
    .createHash("sha256")
    .update(`${salt}:${userId}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Canary selection shared by the key and file name schemes: an explicit list
 * of user ids or e-mail addresses ("*" for everyone), then a stable
 * percentage computed from a salted hash of the user id.
 */
export function isUserSelectedForRollout(
  user: { id: string; email?: string | null },
  canaryUsers: string | undefined,
  rolloutPercent: string | undefined,
  salt: string,
) {
  const canary = (canaryUsers ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (canary.includes("*")) return true;
  if (canary.includes(user.id.toLowerCase())) return true;
  if (user.email && canary.includes(user.email.toLowerCase())) return true;

  const percent = Number.parseInt(rolloutPercent ?? "0", 10);
  if (!Number.isFinite(percent) || percent <= 0) return false;
  return rolloutBucket(salt, user.id) < Math.min(percent, 100);
}

export function isShareDekWriteEnabledFor(
  user: { id: string; email?: string | null } | null | undefined,
  env: FlagEnv = process.env,
) {
  if (!user) return false;
  if (!isShareDekReadEnabled(env)) return false;
  if (!parseFlagBoolean(env.SHARE_DEK_V1_WRITE, false)) return false;
  return isUserSelectedForRollout(
    user,
    env.SHARE_DEK_V1_CANARY_USERS,
    env.SHARE_DEK_V1_ROLLOUT_PERCENT,
    "share-dek-v1",
  );
}

// ----- Client crypto events ----------------------------------------------
//
// Aggregated counters only, kept in process memory and lost on restart. No
// share id, user id, key material or file metadata is ever recorded.

export const SHARE_CRYPTO_EVENTS = [
  "share_created",
  "dek_create_error",
  "unwrap_error",
  "decrypt_error",
  "download_error",
  "rewrap_ok",
  "rewrap_error",
] as const;
export type ShareCryptoEvent = (typeof SHARE_CRYPTO_EVENTS)[number];

export const SHARE_CRYPTO_CLIENTS = ["web", "unknown"] as const;
export type ShareCryptoClient = (typeof SHARE_CRYPTO_CLIENTS)[number];

const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const MAX_COUNTER_KEYS = 500;

export class ShareCryptoCounters {
  private readonly counters = new Map<string, number>();
  private readonly startedAt = new Date();

  record(input: {
    event: ShareCryptoEvent;
    scheme: string;
    client: ShareCryptoClient;
    clientVersion?: string | null;
  }) {
    const version =
      input.clientVersion && CLIENT_VERSION_PATTERN.test(input.clientVersion)
        ? input.clientVersion
        : "unknown";
    const key = [input.event, input.scheme, input.client, version].join("|");
    if (!this.counters.has(key) && this.counters.size >= MAX_COUNTER_KEYS) {
      return;
    }
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  snapshot() {
    return {
      since: this.startedAt.toISOString(),
      counters: [...this.counters.entries()]
        .map(([key, count]) => {
          const [event, scheme, client, clientVersion] = key.split("|");
          return { event, scheme, client, clientVersion, count };
        })
        .sort((a, b) =>
          `${a.event}${a.scheme}${a.client}${a.clientVersion}`.localeCompare(
            `${b.event}${b.scheme}${b.client}${b.clientVersion}`,
          ),
        ),
    };
  }
}

export const shareCryptoCounters = new ShareCryptoCounters();
