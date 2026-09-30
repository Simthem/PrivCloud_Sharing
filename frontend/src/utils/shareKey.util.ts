/**
 * Key of a personal E2E share, as seen by its owner.
 *
 * LEGACY_ACCOUNT_KEY (1, or NULL on every share created before the scheme
 * column existed): files are encrypted directly with K_master and the
 * recipient link carries K_master.
 *
 * SHARE_DEK_V1 (2): files are encrypted with K_share, a random AES-256-GCM key
 * generated for this share only. The recipient link carries K_share. The
 * server stores K_share wrapped by K_master, with the share id authenticated,
 * and never receives it in clear.
 *
 * Recipients never need this module: they always use the #key= fragment.
 */

import {
  exportKeyToBase64,
  generateEncryptionKey,
  importKeyFromBase64,
  unwrapReverseShareKey,
  unwrapShareKey,
  wrapShareKey,
} from "./crypto.util";

export const LEGACY_ACCOUNT_KEY = 1;
export const SHARE_DEK_V1 = 2;
export type ShareCryptoScheme = typeof LEGACY_ACCOUNT_KEY | typeof SHARE_DEK_V1;
export type ShareCryptoSchemeName = "LEGACY_ACCOUNT_KEY" | "SHARE_DEK_V1";

export const SHARE_KEY_WRAP_ALGORITHM = "AES-256-GCM/K_MASTER/AAD-SHARE-ID/V1";

export class UnsupportedShareCryptoSchemeError extends Error {
  constructor(value: unknown) {
    super(`Unsupported share crypto scheme: ${String(value)}`);
    this.name = "UnsupportedShareCryptoSchemeError";
  }
}

/** The wrapped key of a SHARE_DEK_V1 share is missing or cannot be opened. */
export class ShareKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareKeyUnavailableError";
  }
}

export function resolveShareCryptoScheme(
  value: number | null | undefined,
): ShareCryptoScheme {
  if (value === null || value === undefined || value === LEGACY_ACCOUNT_KEY) {
    return LEGACY_ACCOUNT_KEY;
  }
  if (value === SHARE_DEK_V1) return SHARE_DEK_V1;
  throw new UnsupportedShareCryptoSchemeError(value);
}

export function shareCryptoSchemeName(
  value: number | null | undefined,
): ShareCryptoSchemeName {
  return resolveShareCryptoScheme(value) === SHARE_DEK_V1
    ? "SHARE_DEK_V1"
    : "LEGACY_ACCOUNT_KEY";
}

export function isShareDek(share: { cryptoScheme?: number | null }): boolean {
  return share.cryptoScheme === SHARE_DEK_V1;
}

async function sameRawKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.exportKey("raw", a),
    crypto.subtle.exportKey("raw", b),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Generate K_share for a new share and wrap it with K_master. The wrap is
 * opened again before anything is uploaded: a share whose owner copy could
 * not be opened is never created.
 */
export async function createShareDek(
  masterKeyEncoded: string,
  shareId: string,
): Promise<{
  key: CryptoKey;
  encodedKey: string;
  wrappedShareKey: string;
  wrappedShareKeyAlgorithm: string;
}> {
  const masterKey = await importKeyFromBase64(masterKeyEncoded);
  const key = await generateEncryptionKey();
  const wrappedShareKey = await wrapShareKey(key, masterKey, shareId);
  const reopened = await unwrapShareKey(wrappedShareKey, masterKey, shareId);
  if (!(await sameRawKey(key, reopened))) {
    throw new ShareKeyUnavailableError("Share key self-check failed");
  }
  return {
    key,
    encodedKey: await exportKeyToBase64(key),
    wrappedShareKey,
    wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
  };
}

/**
 * Owner-side key of a share, from the material the server returned for it.
 * Reverse-share uploads keep K_rs, SHARE_DEK_V1 shares unwrap K_share, and
 * every other share still uses K_master.
 */
export async function resolveOwnerShareKey(
  shareId: string,
  masterKeyEncoded: string,
  material: {
    encryptedReverseShareKey?: string | null;
    cryptoScheme?: number | null;
    wrappedShareKey?: string | null;
  },
): Promise<string> {
  const masterKey = await importKeyFromBase64(masterKeyEncoded);
  if (material.encryptedReverseShareKey) {
    const rsKey = await unwrapReverseShareKey(
      material.encryptedReverseShareKey,
      masterKey,
    );
    return exportKeyToBase64(rsKey);
  }
  if (resolveShareCryptoScheme(material.cryptoScheme) === SHARE_DEK_V1) {
    if (!material.wrappedShareKey) {
      throw new ShareKeyUnavailableError("Wrapped share key is missing");
    }
    const shareKey = await unwrapShareKey(
      material.wrappedShareKey,
      masterKey,
      shareId,
    );
    return exportKeyToBase64(shareKey);
  }
  return masterKeyEncoded;
}

/**
 * Rewrap K_share from the previous K_master to the new one. K_share itself is
 * unchanged, so the encrypted files and every recipient link stay valid. A
 * wrap already made under the new key (interrupted earlier rotation) is
 * recognised and left alone.
 */
export async function rewrapShareKey(
  wrappedShareKey: string,
  oldMasterKeyEncoded: string,
  newMasterKeyEncoded: string,
  shareId: string,
): Promise<{ wrappedShareKey: string; alreadyRewrapped: boolean }> {
  const [oldMasterKey, newMasterKey] = await Promise.all([
    importKeyFromBase64(oldMasterKeyEncoded),
    importKeyFromBase64(newMasterKeyEncoded),
  ]);
  let shareKey: CryptoKey;
  try {
    shareKey = await unwrapShareKey(wrappedShareKey, oldMasterKey, shareId);
  } catch (error) {
    try {
      await unwrapShareKey(wrappedShareKey, newMasterKey, shareId);
      return { wrappedShareKey, alreadyRewrapped: true };
    } catch {
      throw error;
    }
  }
  const rewrapped = await wrapShareKey(shareKey, newMasterKey, shareId);
  const reopened = await unwrapShareKey(rewrapped, newMasterKey, shareId);
  if (!(await sameRawKey(shareKey, reopened))) {
    throw new ShareKeyUnavailableError("Share key rewrap self-check failed");
  }
  return { wrappedShareKey: rewrapped, alreadyRewrapped: false };
}

/** Client kind and bundle version for anonymous crypto event counters. */
export function describeCryptoClient(): {
  client: "web";
  clientVersion: string;
} {
  return {
    client: "web",
    clientVersion: process.env.VERSION ?? "unknown",
  };
}
