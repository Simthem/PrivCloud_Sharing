/**
 * E2EE Identity Layer - X25519 + Ed25519 per-user key pairs
 *
 * Architecture:
 * - X25519: key exchange (ECDH) for creating grants (encrypting DEKs for recipients)
 * - Ed25519: digital signatures (identity verification, future use)
 *
 * All private keys are encrypted with the user's master AES-256-GCM key
 * BEFORE leaving the browser. The server NEVER sees private keys in plaintext.
 *
 * Post-quantum readiness:
 * - The grant system supports hybrid algorithms (X25519 + ML-KEM-768)
 * - ML-KEM keys are stored separately and used alongside classical keys
 */

import api from "./api.service";
import { selectPqNotificationPublicKey } from "../utils/pqNotification.util";
import { apiPathSegment } from "../utils/apiPath.util";

// ============================================================
// Types
// ============================================================

export interface IdentityKey {
  id: string;
  keyType: "X25519" | "Ed25519";
  publicKey: string; // base64url
  algorithm: string;
  version: number;
}

export interface IdentityKeyWithPrivate extends IdentityKey {
  encryptedPrivateKey: string; // base64url - encrypted with master key
}

export interface UserPublicKeys {
  userId: string;
  x25519: { publicKey: string; algorithm: string; version: number } | null;
  pqKey: { publicKey: string; variant: string; version: number } | null;
}

export interface AccessGrant {
  id: string;
  encryptedFileKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  algorithm: string;
  dekVersion: number;
  fileId?: string;
  teamFileId?: string;
  shareId?: string;
  createdAt: string;
}

export interface GrantResult {
  id: string;
  action: "created" | "updated";
  dekVersion: number;
}

export interface BulkGrantResult {
  total: number;
  success: number;
  failed: number;
  results: Array<{
    recipientUserId: string;
    result: GrantResult | null;
    error?: string;
  }>;
}

// ============================================================
// Identity Key Management
// ============================================================

/**
 * Detect whether the browser supports X25519 in SubtleCrypto.
 * Returns true if generateKey({ name: "X25519" }) is available.
 * Caches the result after first check.
 */
let _x25519Supported: boolean | null = null;
export async function isX25519Supported(): Promise<boolean> {
  if (_x25519Supported !== null) return _x25519Supported;
  try {
    const kp = await crypto.subtle.generateKey(
      { name: "X25519" } as any,
      true,
      ["deriveBits"],
    );
    // Cleanup - we just want to know if it works
    void kp;
    _x25519Supported = true;
  } catch {
    _x25519Supported = false;
  }
  return _x25519Supported;
}

/**
 * Generate an X25519 key pair using Web Crypto API (ECDH with Curve25519).
 * Returns the raw key material for both public and private keys.
 */
export async function generateX25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "X25519" } as any,
    true, // extractable
    ["deriveBits"],
  );

  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKeyRaw = await crypto.subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );

  // X25519 private key is 32 bytes inside the PKCS8 wrapper
  // PKCS8 format: 30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 [32 bytes]
  const pkcs8 = new Uint8Array(privateKeyRaw);
  const privateKey = pkcs8.slice(pkcs8.length - 32);

  return {
    publicKey: new Uint8Array(publicKeyRaw),
    privateKey,
  };
}

/**
 * Generate an Ed25519 key pair for signing.
 */
export async function generateEd25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" } as any,
    true,
    ["sign", "verify"],
  );

  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKeyRaw = await crypto.subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );

  const pkcs8 = new Uint8Array(privateKeyRaw);
  const privateKey = pkcs8.slice(pkcs8.length - 32);

  return {
    publicKey: new Uint8Array(publicKeyRaw),
    privateKey,
  };
}

/**
 * Encrypt a private key with the user's master AES-256-GCM key.
 * Format: [IV 12B][ciphertext+tag]
 */
export async function encryptPrivateKey(
  privateKey: Uint8Array,
  masterKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    masterKey,
    privateKey as any,
  );

  // Concatenate IV + ciphertext
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);

  return arrayBufferToBase64Url(result.buffer);
}

/**
 * Decrypt a private key stored on the server.
 */
export async function decryptPrivateKey(
  encryptedBase64url: string,
  masterKey: CryptoKey,
): Promise<Uint8Array> {
  const data = base64UrlToArrayBuffer(encryptedBase64url);
  const dataView = new Uint8Array(data);
  const iv = dataView.slice(0, 12);
  const ciphertext = dataView.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    masterKey,
    ciphertext,
  );

  return new Uint8Array(plaintext);
}

/**
 * Perform X25519 ECDH to derive a shared secret, then wrap a DEK with AES-256-GCM.
 *
 * Flow (Alice -> Bob):
 * 1. Generate ephemeral X25519 key pair
 * 2. ECDH(ephemeral_SK, Bob_PK) -> shared_secret (32 bytes)
 * 3. HKDF(shared_secret) -> wrapping_key
 * 4. AES-256-GCM(DEK, wrapping_key) -> encrypted_DEK
 * 5. Return: { encryptedFileKey, ephemeralPublicKey, nonce }
 */
export async function wrapDEKForRecipient(
  dek: Uint8Array, // 32 bytes - the file's AES-256-GCM key
  recipientPublicKeyBase64url: string,
): Promise<{
  encryptedFileKey: string;
  ephemeralPublicKey: string;
  nonce: string;
}> {
  // Check browser support
  if (!(await isX25519Supported())) {
    throw new Error(
      "Votre navigateur ne supporte pas X25519. Veuillez mettre à jour votre navigateur (Chrome 113+, Firefox 118+, Safari 17+).",
    );
  }

  // Import recipient's X25519 public key
  const recipientPKRaw = base64UrlToArrayBuffer(recipientPublicKeyBase64url);
  const recipientPK = await crypto.subtle.importKey(
    "raw",
    recipientPKRaw,
    { name: "X25519" } as any,
    false,
    [],
  );

  // Generate ephemeral key pair for this wrap operation
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "X25519" } as any,
    true,
    ["deriveBits"],
  );

  // ECDH: derive shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: recipientPK } as any,
    ephemeralKeyPair.privateKey,
    256, // 32 bytes
  );

  // HKDF: derive wrapping key from shared secret
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"],
  );

  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      salt: new Uint8Array(32), // Zero salt - context provided by ephemeral PK
      info: new TextEncoder().encode("privcloud-grant-v1"),
      hash: "SHA-256",
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  // AES-256-GCM wrap the DEK
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encryptedDEK = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    wrappingKey,
    dek as any,
  );

  // Export ephemeral public key
  const ephemeralPKRaw = await crypto.subtle.exportKey(
    "raw",
    ephemeralKeyPair.publicKey,
  );

  return {
    encryptedFileKey: arrayBufferToBase64Url(encryptedDEK),
    ephemeralPublicKey: arrayBufferToBase64Url(ephemeralPKRaw),
    nonce: arrayBufferToBase64Url(nonce.buffer),
  };
}

/**
 * Unwrap a DEK received via a grant (Bob decrypts).
 *
 * Flow:
 * 1. ECDH(my_SK, ephemeral_PK) -> shared_secret
 * 2. HKDF(shared_secret) -> wrapping_key
 * 3. AES-256-GCM_decrypt(encryptedFileKey, wrapping_key, nonce) -> DEK
 */
export async function unwrapDEKFromGrant(
  grant: {
    encryptedFileKey: string;
    ephemeralPublicKey: string;
    nonce: string;
  },
  myPrivateKeyRaw: Uint8Array, // 32 bytes - decrypted X25519 private key
): Promise<Uint8Array> {
  // Import my X25519 private key
  // Wrap raw 32-byte key in PKCS8 structure for X25519
  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Header.length + 32);
  pkcs8.set(pkcs8Header);
  pkcs8.set(myPrivateKeyRaw, pkcs8Header.length);

  const myPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "X25519" } as any,
    false,
    ["deriveBits"],
  );

  // Import ephemeral public key
  const ephemeralPKRaw = base64UrlToArrayBuffer(grant.ephemeralPublicKey);
  const ephemeralPK = await crypto.subtle.importKey(
    "raw",
    ephemeralPKRaw,
    { name: "X25519" } as any,
    false,
    [],
  );

  // ECDH: derive same shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: ephemeralPK } as any,
    myPrivateKey,
    256,
  );

  // HKDF: derive wrapping key (same params as wrap)
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"],
  );

  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("privcloud-grant-v1"),
      hash: "SHA-256",
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Decrypt the DEK
  const nonceBytes = base64UrlToArrayBuffer(grant.nonce);
  const encryptedDEK = base64UrlToArrayBuffer(grant.encryptedFileKey);

  const dekPlaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceBytes },
    wrappingKey,
    encryptedDEK,
  );

  return new Uint8Array(dekPlaintext);
}

// ============================================================
// API calls
// ============================================================

/**
 * Register identity keys on the server.
 */
export const registerIdentityKey = async (data: {
  keyType: "X25519" | "Ed25519";
  publicKey: string;
  encryptedPrivateKey: string;
  algorithm?: string;
}): Promise<IdentityKey> => {
  return (await api.post("crypto/identity/keys", data)).data;
};

/**
 * Get my identity keys (including encrypted private keys).
 */
export const getMyIdentityKeys = async (): Promise<
  IdentityKeyWithPrivate[]
> => {
  return (await api.get("crypto/identity/keys/me")).data;
};

/**
 * Get a user's public keys (for creating grants).
 */
export const getUserPublicKeys = async (
  userId: string,
): Promise<IdentityKey[]> => {
  return (await api.get(`crypto/identity/keys/user/${apiPathSegment(userId)}`))
    .data;
};

/**
 * Batch fetch public keys for multiple users.
 */
export const batchGetPublicKeys = async (
  userIds: string[],
): Promise<UserPublicKeys[]> => {
  return (await api.post("crypto/identity/keys/batch", { userIds })).data;
};

/**
 * Rotate an identity key.
 */
export const rotateIdentityKey = async (data: {
  keyType: "X25519" | "Ed25519";
  publicKey: string;
  encryptedPrivateKey: string;
  algorithm?: string;
}): Promise<IdentityKey & { previousVersion: number }> => {
  return (await api.put("crypto/identity/keys/rotate", data)).data;
};

/**
 * Register a PQ key (ML-KEM).
 */
export const registerPQKey = async (data: {
  variant?: string;
  publicKey: string;
  encryptedPrivateKey: string;
}): Promise<{
  id: string;
  variant: string;
  publicKey: string;
  version: number;
}> => {
  return (await api.post("crypto/identity/pq-keys", data)).data;
};

/**
 * Get my own PQ key (includes encrypted private key for notification decryption).
 */
export const getMyPQKey = async (): Promise<{
  id: string;
  variant: string;
  publicKey: string;
  encryptedPrivateKey: string;
  version: number;
} | null> => {
  return (await api.get("crypto/identity/pq-keys/me")).data;
};

// ============================================================
// Grants API
// ============================================================

/**
 * Create an access grant (encrypted DEK for a recipient).
 */
export const createAccessGrant = async (data: {
  encryptedFileKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  recipientUserId: string;
  algorithm?: string;
  fileId?: string;
  teamFileId?: string;
  shareId?: string;
}): Promise<GrantResult> => {
  return (await api.post("crypto/grants", data)).data;
};

/**
 * Bulk create grants.
 */
export const createBulkGrants = async (
  grants: Array<{
    encryptedFileKey: string;
    ephemeralPublicKey: string;
    nonce: string;
    recipientUserId: string;
    algorithm?: string;
    encryptedNotification?: string;
    fileId?: string;
    teamFileId?: string;
    shareId?: string;
  }>,
): Promise<BulkGrantResult> => {
  return (await api.post("crypto/grants/bulk", { grants })).data;
};

/**
 * Get my grants (for decryption).
 */
export const getMyGrants = async (filters?: {
  fileId?: string;
  teamFileId?: string;
  shareId?: string;
}): Promise<AccessGrant[]> => {
  const params = new URLSearchParams();
  if (filters?.fileId) params.set("fileId", filters.fileId);
  if (filters?.teamFileId) params.set("teamFileId", filters.teamFileId);
  if (filters?.shareId) params.set("shareId", filters.shareId);
  const query = params.toString();
  return (await api.get(`crypto/grants/me${query ? `?${query}` : ""}`)).data;
};

/**
 * Get grant for a specific file.
 */
export const getGrantForFile = async (fileId: string): Promise<AccessGrant> => {
  return (await api.get(`crypto/grants/file/${apiPathSegment(fileId)}`)).data;
};

/**
 * Get grant for a specific team file.
 */
export const getGrantForTeamFile = async (
  teamFileId: string,
): Promise<AccessGrant> => {
  return (
    await api.get(`crypto/grants/team-file/${apiPathSegment(teamFileId)}`)
  ).data;
};

/**
 * Revoke a specific grant.
 */
export const revokeGrant = async (grantId: string): Promise<void> => {
  await api.delete(`crypto/grants/${apiPathSegment(grantId)}`);
};

/**
 * Revoke all grants for a file (before DEK rotation).
 */
export const revokeAllGrantsForFile = async (
  fileId: string,
): Promise<{ revokedCount: number }> => {
  return (await api.delete(`crypto/grants/file/${apiPathSegment(fileId)}/all`))
    .data;
};

// ============================================================
// Enrollment Tokens API
// ============================================================

export const createEnrollmentToken = async (data: {
  purpose: "ONBOARDING" | "TEAM_JOIN" | "DEVICE_ADD";
  teamId?: string;
  metadata?: string;
  expiresInHours?: number;
}): Promise<{
  id: string;
  token: string;
  purpose: string;
  expiresAt: string;
}> => {
  return (await api.post("crypto/enrollment/tokens", data)).data;
};

export const consumeEnrollmentToken = async (data: {
  token: string;
  publicKey?: string;
}): Promise<{ purpose: string; teamId: string | null; metadata: any }> => {
  return (await api.post("crypto/enrollment/consume", data)).data;
};

export const listEnrollmentTokens = async (): Promise<
  Array<{
    id: string;
    purpose: string;
    status: string;
    teamId: string | null;
    expiresAt: string;
    createdAt: string;
  }>
> => {
  return (await api.get("crypto/enrollment/tokens")).data;
};

export const revokeEnrollmentToken = async (tokenId: string): Promise<void> => {
  await api.delete(`crypto/enrollment/tokens/${apiPathSegment(tokenId)}`);
};

// ============================================================
// Helpers
// ============================================================

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * High-level: Initialize identity keys for a user.
 * Called once during E2E encryption setup.
 *
 * 1. Generate X25519 + Ed25519 key pairs
 * 2. Encrypt private keys with master key
 * 3. Register public keys on server
 */
export async function initializeIdentityKeys(masterKey: CryptoKey): Promise<{
  x25519: IdentityKey;
  ed25519: IdentityKey;
}> {
  // Check browser support before attempting
  if (!(await isX25519Supported())) {
    throw new Error(
      "Browser does not support X25519/Ed25519 - identity keys cannot be generated",
    );
  }

  // Generate key pairs
  const x25519Pair = await generateX25519KeyPair();
  const ed25519Pair = await generateEd25519KeyPair();

  // Encrypt private keys with master key
  const encX25519 = await encryptPrivateKey(x25519Pair.privateKey, masterKey);
  const encEd25519 = await encryptPrivateKey(ed25519Pair.privateKey, masterKey);

  // Register on server
  const x25519Key = await registerIdentityKey({
    keyType: "X25519",
    publicKey: arrayBufferToBase64Url(
      x25519Pair.publicKey.buffer as ArrayBuffer,
    ),
    encryptedPrivateKey: encX25519,
    algorithm: "x25519",
  });

  const ed25519Key = await registerIdentityKey({
    keyType: "Ed25519",
    publicKey: arrayBufferToBase64Url(
      ed25519Pair.publicKey.buffer as ArrayBuffer,
    ),
    encryptedPrivateKey: encEd25519,
    algorithm: "ed25519",
  });

  return { x25519: x25519Key, ed25519: ed25519Key };
}

/**
 * High-level: Share a file's DEK with a team member.
 * Creates a cryptographic grant without the server ever seeing the DEK.
 *
 * @param dekRaw - The file's DEK (32 bytes)
 * @param recipientUserId - The team member's user ID
 * @param target - Which resource to grant access to
 */
export async function grantFileAccess(
  dekRaw: Uint8Array,
  recipientUserId: string,
  target: { fileId?: string; teamFileId?: string; shareId?: string },
): Promise<GrantResult> {
  // Fetch recipient's public key
  const pubKeys = await getUserPublicKeys(recipientUserId);
  const x25519Key = pubKeys.find((k) => k.keyType === "X25519");

  if (!x25519Key) {
    throw new Error("Le destinataire n'a pas configuré ses clés E2EE (X25519)");
  }

  // Wrap DEK for recipient
  const wrapped = await wrapDEKForRecipient(dekRaw, x25519Key.publicKey);

  // Create grant on server
  return createAccessGrant({
    ...wrapped,
    recipientUserId,
    algorithm: "x25519-aes256gcm",
    ...target,
  });
}

/**
 * High-level: Share a file's DEK with all team members who have folder access.
 */
export async function grantFileAccessToTeam(
  dekRaw: Uint8Array,
  teamMembers: Array<{ userId: string }>,
  target: { fileId?: string; teamFileId?: string; shareId?: string },
  notificationMetadata?: Record<string, unknown>,
  usePqNotificationEncryption = false,
): Promise<BulkGrantResult> {
  // Batch fetch public keys
  const userIds = teamMembers.map((m) => m.userId);
  const pubKeysMap = await batchGetPublicKeys(userIds);

  // Create grants for each member who has a key
  const grants: Array<{
    encryptedFileKey: string;
    ephemeralPublicKey: string;
    nonce: string;
    recipientUserId: string;
    algorithm: string;
    encryptedNotification?: string;
    fileId?: string;
    teamFileId?: string;
    shareId?: string;
  }> = [];

  for (const entry of pubKeysMap) {
    if (!entry.x25519) continue; // Skip members without keys

    const wrapped = await wrapDEKForRecipient(dekRaw, entry.x25519.publicKey);

    // ML-KEM is a Team-level opt-in. Members without a PQ key always retain
    // the established X25519 notification path.
    let encryptedNotification: string | undefined;
    if (notificationMetadata) {
      try {
        encryptedNotification = await encryptNotificationMetadata(
          notificationMetadata,
          entry.x25519.publicKey,
          selectPqNotificationPublicKey(
            usePqNotificationEncryption,
            entry.pqKey?.publicKey,
          ),
        );
      } catch {
        // Encryption failed - notification will fall back to plaintext server-side
      }
    }

    grants.push({
      ...wrapped,
      recipientUserId: entry.userId,
      algorithm: "x25519-aes256gcm",
      encryptedNotification,
      ...target,
    });
  }

  if (grants.length === 0) {
    return { total: 0, success: 0, failed: 0, results: [] };
  }

  return createBulkGrants(grants);
}

// ============================================================
// Post-Quantum Hybrid Layer (X25519 + ML-KEM-768)
// ============================================================

/**
 * Post-quantum hybrid key encapsulation.
 *
 * Architecture:
 * - Classical: X25519 ECDH (as above)
 * - PQ: ML-KEM-768 (CRYSTALS-Kyber) via external WASM module
 * - Combined: shared_secret = HKDF(X25519_shared || ML_KEM_shared)
 *
 * The ML-KEM module is loaded dynamically to avoid bundle bloat
 * for users who don't need PQ protection yet.
 *
 * NOTE: ML-KEM-768 is not yet in Web Crypto API (as of 2025).
 * This uses a verified WASM implementation loaded on demand.
 */

type MLKEM768 = (typeof import("@noble/post-quantum/ml-kem.js"))["ml_kem768"];
let mlKem768: MLKEM768 | null = null;

/**
 * Dynamically load the bundled, FIPS-203 ML-KEM-768 implementation. Keeping
 * this as a dynamic import prevents the PQ code from entering the initial app
 * bundle while ensuring production images contain the implementation.
 */
async function loadMLKEM(): Promise<MLKEM768> {
  if (mlKem768) return mlKem768;
  try {
    ({ ml_kem768: mlKem768 } = await import("@noble/post-quantum/ml-kem.js"));
    return mlKem768;
  } catch (error) {
    throw new Error(
      `Module ML-KEM-768 indisponible: ${error instanceof Error ? error.message : "erreur de chargement"}`,
    );
  }
}

/**
 * Generate an ML-KEM-768 key pair.
 * Returns encapsulation key (public) and decapsulation key (private).
 */
export async function generateMLKEMKeyPair(): Promise<{
  publicKey: Uint8Array; // 1184 bytes (ML-KEM-768 ek)
  privateKey: Uint8Array; // 2400 bytes (ML-KEM-768 dk)
}> {
  const mlkem = await loadMLKEM();
  const { publicKey, secretKey } = mlkem.keygen();
  return {
    publicKey: new Uint8Array(publicKey),
    privateKey: new Uint8Array(secretKey),
  };
}

/**
 * Derives a wrapping key from two shared secrets using HKDF-SHA256.
 * The combined input (classical ECDH + ML-KEM shared secret) is imported
 * as HKDF key material and derived into an AES-256-GCM key.
 *
 * This helper is intentionally separate to isolate the crypto.subtle.importKey
 * call from the dynamic shared secrets (which are computed at runtime, NOT hardcoded).
 */
async function deriveHybridWrappingKey(
  ssClassical: Uint8Array,
  ssPQ: Uint8Array,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  if (ssClassical.length === 0 || ssPQ.length === 0) {
    throw new Error("Hybrid shared secrets must not be empty");
  }
  const combined = new Uint8Array(ssClassical.length + ssPQ.length);
  combined.set(ssClassical, 0);
  combined.set(ssPQ, ssClassical.length);

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    combined,
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      salt: new Uint8Array(32), // fixed empty salt (protocol-defined, not a secret)
      info: new TextEncoder().encode("privcloud-hybrid-v1"),
      hash: "SHA-256",
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

/**
 * Hybrid wrap: X25519 + ML-KEM-768 combined.
 *
 * Flow:
 * 1. X25519 ECDH -> ss_classical (32 bytes)
 * 2. ML-KEM Encapsulate(recipient_ek) -> (ciphertext, ss_pq) (32 bytes)
 * 3. combined_secret = HKDF-SHA256(ss_classical || ss_pq, info="privcloud-hybrid-v1")
 * 4. AES-256-GCM(DEK, combined_secret) -> encrypted_dek
 * 5. Return: { encryptedFileKey, ephemeralPublicKey, nonce, kemCiphertext }
 */
export async function hybridWrapDEK(
  dek: Uint8Array,
  recipientX25519PK: string, // base64url
  recipientMLKEMPK: string, // base64url (1184 bytes)
): Promise<{
  encryptedFileKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  kemCiphertext: string; // ML-KEM ciphertext (1088 bytes)
  algorithm: string;
}> {
  const mlkem = await loadMLKEM();

  // Step 1: Classical X25519 ECDH
  const recipientPKRaw = base64UrlToArrayBuffer(recipientX25519PK);
  const recipientPK = await crypto.subtle.importKey(
    "raw",
    recipientPKRaw,
    { name: "X25519" } as any,
    false,
    [],
  );

  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "X25519" } as any,
    true,
    ["deriveBits"],
  );

  const ssClassical = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: recipientPK } as any,
      ephemeralKeyPair.privateKey,
      256,
    ),
  );

  // Step 2: ML-KEM-768 Encapsulation
  const mlkemPKRaw = base64UrlToArrayBuffer(recipientMLKEMPK);
  const { cipherText, sharedSecret: ssPQ } = mlkem.encapsulate(
    new Uint8Array(mlkemPKRaw),
  );

  // Step 3: Combine secrets via HKDF
  const wrappingKey = await deriveHybridWrappingKey(
    ssClassical,
    new Uint8Array(ssPQ),
    ["encrypt"],
  );

  // Step 4: Encrypt DEK
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encryptedDEK = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    wrappingKey,
    dek as any,
  );

  const ephemeralPKRaw = await crypto.subtle.exportKey(
    "raw",
    ephemeralKeyPair.publicKey,
  );

  return {
    encryptedFileKey: arrayBufferToBase64Url(encryptedDEK),
    ephemeralPublicKey: arrayBufferToBase64Url(ephemeralPKRaw),
    nonce: arrayBufferToBase64Url(nonce.buffer),
    kemCiphertext: arrayBufferToBase64Url(cipherText.buffer),
    algorithm: "x25519-mlkem768-aes256gcm",
  };
}

/**
 * Hybrid unwrap: X25519 + ML-KEM-768.
 *
 * Flow (recipient side):
 * 1. X25519 ECDH(my_SK, ephemeral_PK) -> ss_classical
 * 2. ML-KEM Decapsulate(ciphertext, my_dk) -> ss_pq
 * 3. combined_secret = HKDF(ss_classical || ss_pq, info="privcloud-hybrid-v1")
 * 4. AES-256-GCM_decrypt(encryptedFileKey, combined_secret, nonce) -> DEK
 */
export async function hybridUnwrapDEK(
  grant: {
    encryptedFileKey: string;
    ephemeralPublicKey: string;
    nonce: string;
    kemCiphertext: string;
  },
  myX25519SK: Uint8Array, // 32 bytes
  myMLKEMSK: Uint8Array, // 2400 bytes (ML-KEM-768 dk)
): Promise<Uint8Array> {
  const mlkem = await loadMLKEM();

  // Step 1: Classical ECDH
  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Header.length + 32);
  pkcs8.set(pkcs8Header);
  pkcs8.set(myX25519SK, pkcs8Header.length);

  const myPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "X25519" } as any,
    false,
    ["deriveBits"],
  );

  const ephemeralPKRaw = base64UrlToArrayBuffer(grant.ephemeralPublicKey);
  const ephemeralPK = await crypto.subtle.importKey(
    "raw",
    ephemeralPKRaw,
    { name: "X25519" } as any,
    false,
    [],
  );

  const ssClassical = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: ephemeralPK } as any,
      myPrivateKey,
      256,
    ),
  );

  // Step 2: ML-KEM Decapsulation
  const ciphertextRaw = base64UrlToArrayBuffer(grant.kemCiphertext);
  const ssPQ = mlkem.decapsulate(new Uint8Array(ciphertextRaw), myMLKEMSK);

  // Step 3: Combine secrets
  const wrappingKey = await deriveHybridWrappingKey(
    ssClassical,
    new Uint8Array(ssPQ),
    ["decrypt"],
  );

  // Step 4: Decrypt DEK
  const nonceBytes = base64UrlToArrayBuffer(grant.nonce);
  const encryptedDEK = base64UrlToArrayBuffer(grant.encryptedFileKey);

  const dekPlaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceBytes },
    wrappingKey,
    encryptedDEK,
  );

  return new Uint8Array(dekPlaintext);
}

/**
 * High-level: Initialize PQ keys for a user (in addition to classical keys).
 * Called once after the user unlocks their E2E master key.
 */
export async function initializePQKeys(masterKey: CryptoKey): Promise<{
  id: string;
  variant: string;
  publicKey: string;
  version: number;
}> {
  const pair = await generateMLKEMKeyPair();
  const encPrivate = await encryptPrivateKey(pair.privateKey, masterKey);

  return registerPQKey({
    variant: "ML-KEM-768",
    publicKey: arrayBufferToBase64Url(pair.publicKey.buffer as ArrayBuffer),
    encryptedPrivateKey: encPrivate,
  });
}

// ============================================================
// E2E Encrypted Notification Metadata (PQ-hybrid)
// ============================================================

export interface EncryptedNotificationEnvelope {
  ciphertext: string; // base64url - AES-256-GCM encrypted JSON metadata
  ephemeralPublicKey: string; // base64url - sender's ephemeral X25519 PK
  nonce: string; // base64url - 12 bytes IV
  kemCiphertext: string | null; // base64url - ML-KEM-768 ciphertext (null if classical)
  algorithm: string; // "x25519-aes256gcm" or "x25519-mlkem768-aes256gcm"
}

/**
 * Encrypt notification metadata for a recipient using PQ-hybrid (if available).
 * Uses the same hybrid mechanism as DEK wrapping but encrypts JSON metadata.
 *
 * @param metadata - The notification metadata (senderName, fileName, etc.)
 * @param recipientX25519PK - Recipient's X25519 public key (base64url)
 * @param recipientMLKEMPK - Recipient's ML-KEM-768 public key (base64url, optional)
 * @returns JSON string of the encrypted envelope
 */
export async function encryptNotificationMetadata(
  metadata: Record<string, unknown>,
  recipientX25519PK: string,
  recipientMLKEMPK?: string | null,
): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(metadata));

  let envelope: EncryptedNotificationEnvelope;

  if (recipientMLKEMPK) {
    // Hybrid PQ mode
    const result = await hybridWrapDEK(
      plaintext,
      recipientX25519PK,
      recipientMLKEMPK,
    );
    envelope = {
      ciphertext: result.encryptedFileKey,
      ephemeralPublicKey: result.ephemeralPublicKey,
      nonce: result.nonce,
      kemCiphertext: result.kemCiphertext,
      algorithm: result.algorithm,
    };
  } else {
    // Classical X25519-only mode
    const result = await wrapDEKForRecipient(plaintext, recipientX25519PK);
    envelope = {
      ciphertext: result.encryptedFileKey,
      ephemeralPublicKey: result.ephemeralPublicKey,
      nonce: result.nonce,
      kemCiphertext: null,
      algorithm: "x25519-aes256gcm",
    };
  }

  return JSON.stringify(envelope);
}

/**
 * Decrypt E2E-encrypted notification metadata.
 * Uses the recipient's private keys to recover the plaintext JSON metadata.
 *
 * @param encryptedMetadataJson - The JSON string of the encrypted envelope
 * @param masterKey - User's master AES-256-GCM key (for decrypting private keys)
 * @returns Decrypted metadata object, or null on failure
 */
export async function decryptNotificationMetadata(
  encryptedMetadataJson: string,
  masterKey: CryptoKey,
): Promise<Record<string, unknown> | null> {
  try {
    const envelope: EncryptedNotificationEnvelope = JSON.parse(
      encryptedMetadataJson,
    );

    // Fetch user's identity keys (X25519 private key)
    const identityKeys = await getMyIdentityKeys();
    const x25519Key = identityKeys.find((k) => k.keyType === "X25519");
    if (!x25519Key) return null;

    const x25519SK = await decryptPrivateKey(
      x25519Key.encryptedPrivateKey,
      masterKey,
    );

    let plaintext: Uint8Array;

    if (
      envelope.algorithm === "x25519-mlkem768-aes256gcm" &&
      envelope.kemCiphertext
    ) {
      // Hybrid PQ decryption
      const myPQKey = await getMyPQKey();
      if (!myPQKey) return null;

      const mlkemSK = await decryptPrivateKey(
        myPQKey.encryptedPrivateKey,
        masterKey,
      );

      plaintext = await hybridUnwrapDEK(
        {
          encryptedFileKey: envelope.ciphertext,
          ephemeralPublicKey: envelope.ephemeralPublicKey,
          nonce: envelope.nonce,
          kemCiphertext: envelope.kemCiphertext,
        },
        x25519SK,
        mlkemSK,
      );
    } else {
      // Classical X25519-only decryption
      plaintext = await unwrapDEKFromGrant(
        {
          encryptedFileKey: envelope.ciphertext,
          ephemeralPublicKey: envelope.ephemeralPublicKey,
          nonce: envelope.nonce,
        },
        x25519SK,
      );
    }

    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

/**
 * High-level: Grant with hybrid protection if recipient supports PQ.
 * Falls back to classical X25519-only if no PQ key available.
 */
export async function grantFileAccessHybrid(
  dekRaw: Uint8Array,
  recipientUserId: string,
  target: { fileId?: string; teamFileId?: string; shareId?: string },
): Promise<GrantResult> {
  const pubKeys = await batchGetPublicKeys([recipientUserId]);
  const entry = pubKeys[0];

  if (!entry?.x25519) {
    throw new Error("Le destinataire n'a pas configuré ses clés E2EE (X25519)");
  }

  let wrapped: any;
  if (entry.pqKey) {
    // Hybrid mode: X25519 + ML-KEM-768
    wrapped = await hybridWrapDEK(
      dekRaw,
      entry.x25519.publicKey,
      entry.pqKey.publicKey,
    );
  } else {
    // Classical mode: X25519 only
    wrapped = await wrapDEKForRecipient(dekRaw, entry.x25519.publicKey);
    wrapped.algorithm = "x25519-aes256gcm";
  }

  return createAccessGrant({
    ...wrapped,
    recipientUserId,
    ...target,
  });
}

/**
 * Get team shares (received + sent) for the current user in a team.
 */
export interface TeamShareFileInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  folderId: string | null;
  folderName: string | null;
}

export interface TeamShareEntry {
  id: string;
  createdAt: string;
  grantor?: { username: string; email: string };
  recipient?: { username: string; email: string };
  fileInfo: TeamShareFileInfo | null;
}

export interface TeamSharesResponse {
  received: TeamShareEntry[];
  sent: TeamShareEntry[];
  pagination: {
    received: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    sent: { page: number; limit: number; total: number; totalPages: number };
  };
}

export async function getTeamShares(
  teamId: string,
  options: { receivedPage?: number; sentPage?: number; limit?: number } = {},
): Promise<TeamSharesResponse> {
  const params = new URLSearchParams();
  if (options.receivedPage)
    params.set("receivedPage", String(options.receivedPage));
  if (options.sentPage) params.set("sentPage", String(options.sentPage));
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return (
    await api.get(
      `crypto/grants/team/${apiPathSegment(teamId)}/shares${query ? `?${query}` : ""}`,
    )
  ).data;
}
