/**
 * E2E Encryption utilities for OttrBox
 *
 * Algorithme : AES-256-GCM (Web Crypto API)
 * Format fichier chiffré : [IV 12 octets][ciphertext + tag 16 octets]
 * Clé partagée via le fragment d'URL (#key=<base64url>)
 *
 * La clé n'est JAMAIS envoyée au serveur.
 */

const IV_LENGTH = 12; // 96 bits, recommandé pour AES-GCM

// ─── Génération de clé ────────────────────────────────────────────

export async function generateEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable
    ["encrypt", "decrypt"],
  );
}

// ─── Export / Import de clé (base64url) ───────────────────────────

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64Url(raw);
}

export async function importKeyFromBase64(
  encoded: string,
): Promise<CryptoKey> {
  const raw = base64UrlToArrayBuffer(encoded);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ─── Chiffrement d'un fichier ─────────────────────────────────────

/**
 * Chiffre un ArrayBuffer avec AES-256-GCM.
 * Retourne : [IV (12 octets)][ciphertext + auth tag (16 octets)]
 */
export async function encryptFile(
  plaintext: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  // Concaténer IV + ciphertext
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);

  return result.buffer;
}

// ─── Déchiffrement d'un fichier ───────────────────────────────────

/**
 * Déchiffre un ArrayBuffer au format [IV][ciphertext+tag].
 * Retourne le plaintext.
 */
export async function decryptFile(
  encrypted: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const data = new Uint8Array(encrypted);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);

  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

// ─── Stockage de la clé utilisateur (localStorage) ───────────────

const USER_KEY_STORAGE = "ottrbox_e2e_user_key";

export function storeUserKey(encodedKey: string): void {
  try {
    localStorage.setItem(USER_KEY_STORAGE, encodedKey);
  } catch {
    console.warn("Impossible de stocker la clé E2E utilisateur dans localStorage");
  }
}

export function getUserKey(): string | null {
  try {
    return localStorage.getItem(USER_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function removeUserKey(): void {
  try {
    localStorage.removeItem(USER_KEY_STORAGE);
  } catch {
    // silencieux
  }
}

// ─── Hash de clé (SHA-256 hex) pour vérification serveur ─────────

/**
 * Calcule le SHA-256 hex d'une CryptoKey.
 * Ce hash est stocké côté serveur pour vérification,
 * jamais la clé elle-même.
 */
export async function computeKeyHash(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", raw);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Calcule le SHA-256 hex à partir d'une clé encodée en base64url.
 */
export async function computeKeyHashFromEncoded(
  encodedKey: string,
): Promise<string> {
  const key = await importKeyFromBase64(encodedKey);
  return computeKeyHash(key);
}

// ─── Stockage local des clés par share (legacy / migration) ──────

const STORAGE_PREFIX = "ottrbox_e2e_key_";

export function storeShareKey(shareId: string, encodedKey: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${shareId}`, encodedKey);
  } catch {
    console.warn("Impossible de stocker la clé E2E dans localStorage");
  }
}

export function getStoredShareKey(shareId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${shareId}`);
  } catch {
    return null;
  }
}

export function removeStoredShareKey(shareId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${shareId}`);
  } catch {
    // silencieux
  }
}

// ─── Extraction de la clé depuis le fragment d'URL ───────────────

/**
 * Extrait la clé base64url depuis window.location.hash.
 * Format attendu : #key=<base64url>
 */
export function extractKeyFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash) return null;

  const match = hash.match(/[#&]key=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Construit le fragment #key=... à ajouter à une URL de partage.
 */
export function buildKeyFragment(encodedKey: string): string {
  return `#key=${encodedKey}`;
}

// ─── Wrapping / Unwrapping de clé (pour reverse shares E2E) ─────

/**
 * Chiffre K_rs avec K_master (AES-GCM key-wrapping).
 * Retourne la clé chiffrée en base64url : [IV 12B][ciphertext+tag]
 *
 * Utilisé à la création d'un reverse share :
 *   encryptedReverseShareKey = await wrapReverseShareKey(K_rs, K_master)
 */
export async function wrapReverseShareKey(
  rsKey: CryptoKey,
  masterKey: CryptoKey,
): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", rsKey);
  const encrypted = await encryptFile(raw, masterKey);
  return arrayBufferToBase64Url(encrypted);
}

/**
 * Déchiffre K_rs avec K_master.
 * Prend la valeur base64url stockée en BDD et retourne la CryptoKey.
 *
 * Utilisé par l'owner pour consulter les fichiers reçus via reverse share.
 */
export async function unwrapReverseShareKey(
  encryptedBase64: string,
  masterKey: CryptoKey,
): Promise<CryptoKey> {
  const encrypted = base64UrlToArrayBuffer(encryptedBase64);
  const raw = await decryptFile(encrypted, masterKey);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ─── Téléchargement déchiffré ─────────────────────────────────────

/**
 * Crée un lien de téléchargement pour un Blob déchiffré.
 */
export function downloadDecryptedBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Révoquer après un court délai pour laisser le temps au navigateur
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Utilitaires base64url ────────────────────────────────────────

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  // Restaurer le base64 standard
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  // Ajouter le padding
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
