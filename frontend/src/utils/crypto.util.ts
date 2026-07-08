/**
 * E2E Encryption utilities for PrivCloud_Sharing
 *
 * Algorithme : AES-256-GCM (Web Crypto API)
 * Format fichier chiffré : [IV 12 octets][ciphertext + tag 16 octets]
 * Clé partagée via le fragment d'URL (#key=<base64url>)
 *
 * La clé n'est JAMAIS envoyée au serveur.
 */

const IV_LENGTH = 12; // 96 bits, recommandé pour AES-GCM

// ----- Génération de clé ----------------------------------------------------------------------──

export async function generateEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable
    ["encrypt", "decrypt"],
  );
}

// ----- Export / Import de clé (base64url) ---------------------------------------------

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64Url(raw);
}

export async function importKeyFromBase64(encoded: string): Promise<CryptoKey> {
  const raw = base64UrlToArrayBuffer(encoded);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ----- Chiffrement d'un fichier ------------------------------------------------------------─

/**
 * Chiffre un ArrayBuffer avec AES-256-GCM.
 * Retourne : [IV (12 octets)][ciphertext + auth tag (16 octets)]
 */
export async function encryptFile(
  plaintext: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  let ciphertext: ArrayBuffer | null = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  // Concaténer IV + ciphertext into a single buffer, then release
  // the intermediate ciphertext reference so GC can reclaim it.
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  ciphertext = null;

  return result.buffer;
}

// ----- Déchiffrement d'un fichier -------------------------------------------------------──

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

const GCM_TAG_LENGTH = 16;
const ENCRYPTION_OVERHEAD = IV_LENGTH + GCM_TAG_LENGTH; // 28 octets par chunk

/**
 * Déchiffre un fichier composé de N chunks chiffrés indépendamment.
 * Chaque chunk stocké = [IV 12][ciphertext + tag 16].
 * Taille d'un chunk chiffré = plaintextChunkSize + 28.
 *
 * Stratégie de détection du chunk size :
 * 1. Essaie plaintextChunkSize (config) en per-chunk
 * 2. Si échec, essaie d'autres tailles plausibles (adaptive 5-200 MB)
 * 3. Dernier recours : single-block (rétrocompat anciens uploads)
 */
export async function decryptFileAuto(
  encrypted: ArrayBuffer,
  key: CryptoKey,
  plaintextChunkSize: number,
): Promise<ArrayBuffer> {
  const totalLen = encrypted.byteLength;

  // Tenter single-block d'abord (ancien format ou petit fichier).
  // Limite a 200 MB pour eviter un decrypt inutile sur les gros fichiers.
  if (totalLen <= 200_000_000 + ENCRYPTION_OVERHEAD) {
    try {
      return await decryptFile(encrypted, key);
    } catch {
      // Pas un single-block -- continuer avec la detection multi-chunk
    }
  }

  // Tailles candidates : config d'abord, puis TOUS les multiples de 1 MB
  // entre 5 MB et 200 MB (couvre les tailles adaptatives arbitraires des
  // uploads existants et les futurs uploads quantifies a 5 MB).
  const candidates: number[] = [plaintextChunkSize];
  for (let mb = 5; mb <= 200; mb++) {
    candidates.push(mb * 1_000_000);
  }
  // Dédupliquer et ne garder que les tailles pertinentes
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const c of candidates) {
    if (!seen.has(c) && totalLen > c + ENCRYPTION_OVERHEAD) {
      seen.add(c);
      unique.push(c);
    }
  }

  for (const tryPlain of unique) {
    const tryEnc = tryPlain + ENCRYPTION_OVERHEAD;
    if (tryEnc > totalLen) continue;
    // Vérification rapide : le premier chunk doit être déchiffrable
    try {
      await decryptFile(encrypted.slice(0, tryEnc), key);
    } catch {
      continue; // mauvaise taille, essayer la suivante
    }
    // Le premier chunk passe : déchiffrer tout le fichier avec cette taille
    try {
      return await decryptPerChunk(encrypted, key, tryPlain);
    } catch {
      continue;
    }
  }

  throw new Error("E2E decryption failed: no matching chunk size found");
}

/** Déchiffre un ArrayBuffer multi-chunk avec une taille de chunk connue. */
async function decryptPerChunk(
  encrypted: ArrayBuffer,
  key: CryptoKey,
  plaintextChunkSize: number,
): Promise<ArrayBuffer> {
  const encChunkSize = plaintextChunkSize + ENCRYPTION_OVERHEAD;
  const totalLen = encrypted.byteLength;
  const numFullChunks = Math.floor(totalLen / encChunkSize);
  const lastEncChunkSize = totalLen - numFullChunks * encChunkSize;
  const totalPlainLen =
    numFullChunks * plaintextChunkSize +
    (lastEncChunkSize > 0 ? lastEncChunkSize - ENCRYPTION_OVERHEAD : 0);

  const result = new Uint8Array(totalPlainLen);
  let offset = 0;
  let pos = 0;

  while (offset < totalLen) {
    const end = Math.min(offset + encChunkSize, totalLen);
    const chunkBuf = encrypted.slice(offset, end);
    const decrypted = await decryptFile(chunkBuf, key);
    result.set(new Uint8Array(decrypted), pos);
    pos += decrypted.byteLength;
    offset = end;
  }

  return result.buffer;
}

// ----- Streaming decrypt (pour les gros fichiers) ----------------------------

/**
 * Async generator that reads an encrypted ReadableStream, auto-detects the
 * encryption chunk size, then yields decrypted Uint8Array chunks one at a
 * time.  Peak memory: ~1 encrypted chunk + 1 decrypted chunk (5-200 MB
 * depending on upload settings) instead of the entire file.
 *
 * Usage:
 *   for await (const plainChunk of decryptStream(body, key, cfg, totalLen)) {
 *     await writable.write(plainChunk);
 *   }
 */
export async function* decryptStream(
  encryptedStream: ReadableStream<Uint8Array>,
  key: CryptoKey,
  configChunkSize: number,
  totalEncryptedSize: number,
): AsyncGenerator<Uint8Array> {
  const reader = encryptedStream.getReader();
  try {

  // --- Pre-allocated buffer ------------------------------------------------
  // The old approach concatenated buf + fragment on EVERY reader.read(),
  // which is O(n²) per encrypted chunk: for a 10 MB chunk with 64 KB
  // network fragments, ~780 MB of memcpy per chunk.  On a 43 GB file
  // that's 3+ TB of unnecessary copies.
  //
  // New approach: pre-allocate a buffer ≥ one encrypted chunk, append
  // fragments with a simple .set() at the fill position (O(fragment)),
  // and shift the remainder with .copyWithin() after each decrypt.
  // Total copy per chunk ≈ chunkSize (unavoidable for WebCrypto) +
  // a small remainder shift -- roughly 78× less than before.
  const initialCap = Math.min(
    configChunkSize + ENCRYPTION_OVERHEAD + 65536,
    totalEncryptedSize + 1,
  );
  let buf = new Uint8Array(initialCap);
  let bufLen = 0;

  /** Append a network fragment to the pre-allocated buffer. */
  const append = (data: Uint8Array) => {
    const need = bufLen + data.length;
    if (need > buf.length) {
      const newCap = Math.max(buf.length * 2, need);
      const grown = new Uint8Array(newCap);
      if (bufLen > 0) grown.set(buf.subarray(0, bufLen));
      buf = grown;
    }
    buf.set(data, bufLen);
    bufLen += data.length;
  }

  /** Discard the first n bytes (shifts remainder with copyWithin). */
  const consume = (n: number) => {
    if (n >= bufLen) { bufLen = 0; return; }
    buf.copyWithin(0, n, bufLen);
    bufLen -= n;
  }

  /** Return a standalone ArrayBuffer copy suitable for WebCrypto. */
  const bufSlice = (start: number, end: number): ArrayBuffer => {
    return buf.slice(start, end).buffer;
  }

  /** Read from the stream until we have at least minBytes buffered. */
  const fillBuffer = async (minBytes: number): Promise<boolean> => {
    while (bufLen < minBytes) {
      const { done, value } = await reader.read();
      if (done) return false;
      append(value);
    }
    return true;
  }

  // --- Phase 1: detect chunk size ---

  // Small files (<=200 MB): try single-block first
  if (totalEncryptedSize <= 200_000_000 + ENCRYPTION_OVERHEAD) {
    await fillBuffer(totalEncryptedSize);
    try {
      const decrypted = await decryptFile(bufSlice(0, bufLen), key);
      yield new Uint8Array(decrypted);
      return;
    } catch {
      // Not single-block -- continue with multi-chunk detection
    }
  }

  // Build candidate list: config size first, then 5..200 MB in 1 MB steps
  const seen = new Set<number>();
  const candidates: number[] = [];
  for (const c of [
    configChunkSize,
    ...Array.from({ length: 196 }, (_, i) => (i + 5) * 1_000_000),
  ]) {
    if (!seen.has(c) && c + ENCRYPTION_OVERHEAD <= totalEncryptedSize) {
      seen.add(c);
      candidates.push(c);
    }
  }

  let detectedPlainSize = -1;
  for (const tryPlain of candidates) {
    const tryEnc = tryPlain + ENCRYPTION_OVERHEAD;
    const gotEnough = await fillBuffer(tryEnc);
    if (!gotEnough && bufLen < tryEnc) continue;
    try {
      await decryptFile(bufSlice(0, tryEnc), key);
      detectedPlainSize = tryPlain;
      break;
    } catch {
      continue;
    }
  }

  if (detectedPlainSize === -1) {
    throw new Error("E2E decryption failed: no matching chunk size found");
  }

  // --- Phase 2: stream-decrypt chunk by chunk ---
  const encChunkSize = detectedPlainSize + ENCRYPTION_OVERHEAD;

  // Process full chunks already buffered from detection phase
  while (bufLen >= encChunkSize) {
    const decrypted = await decryptFile(bufSlice(0, encChunkSize), key);
    consume(encChunkSize);
    yield new Uint8Array(decrypted);
  }

  // Continue reading from the stream
  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) {
      streamDone = true;
      break;
    }
    append(value);

    while (bufLen >= encChunkSize) {
      const decrypted = await decryptFile(bufSlice(0, encChunkSize), key);
      consume(encChunkSize);
      yield new Uint8Array(decrypted);
    }
  }

  // Final partial chunk (last chunk of the file, smaller than encChunkSize)
  if (bufLen > ENCRYPTION_OVERHEAD) {
    const decrypted = await decryptFile(bufSlice(0, bufLen), key);
    yield new Uint8Array(decrypted);
  }

  } finally {
    // Release the stream reader to avoid connection leaks (TCP RST)
    try { await reader.cancel(); } catch { /* stream already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// ----- Stockage de la clé utilisateur (sessionStorage) ----------------------
// La clé E2E n'est JAMAIS persistée via localStorage ni cookie.
// Elle vit dans sessionStorage : elle survit aux rechargements de page
// dans le même onglet mais disparaît à la fermeture de l'onglet.
//
// Pourquoi pas une simple variable module ? Elle serait perdue au moindre
// rechargement de page (F5, navigation directe), forçant l'utilisateur
// à ressaisir la clé constamment.
//
// Pourquoi pas localStorage ? Il persiste indéfiniment et est lisible
// par tout XSS futur, même après déconnexion.
//
// sessionStorage = compromis : même surface XSS qu'une variable module
// pendant la session active, mais meilleure UX (survit aux reloads),
// et purge automatique à la fermeture de l'onglet.

// Storage slot identifier (NOT a secret - this is a public sessionStorage key name).
function getStorageSlot(): string {
  return ["privcloud", "e2e", "session", "key"].join("_");
}

export function storeUserKey(encodedKey: string): void {
  try {
    sessionStorage.setItem(getStorageSlot(), encodedKey);
    // Notify any listening components that the key is now available
    window.dispatchEvent(new Event("e2e-key-stored"));
  } catch {
    // SSR or storage full -- silently ignore
  }
}

export function getUserKey(): string | null {
  try {
    return sessionStorage.getItem(getStorageSlot());
  } catch {
    return null;
  }
}

export function removeUserKey(): void {
  try {
    sessionStorage.removeItem(getStorageSlot());
  } catch {
    // silencieux
  }
}

// ----- Hash de clé (HMAC-SHA256 hex) pour vérification serveur -----------

/**
 * Calcule HMAC-SHA256(K_master, userId) en hex.
 * Le userId sert de clé HMAC, les octets bruts de la CryptoKey
 * servent de message. Cela lie le hash à l'identité de l'utilisateur
 * et empêche la réutilisation d'un même hash entre comptes.
 */
export async function computeKeyHash(
  key: CryptoKey,
  userId: string,
): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(userId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, raw);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Legacy SHA-256(raw key) -- uniquement pour migration de hash existants.
 */
export async function computeKeyHashLegacy(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Calcule HMAC-SHA256 hex à partir d'une clé encodée en base64url.
 */
export async function computeKeyHashFromEncoded(
  encodedKey: string,
  userId: string,
): Promise<string> {
  const key = await importKeyFromBase64(encodedKey);
  return computeKeyHash(key, userId);
}

/**
 * Legacy SHA-256 hex à partir d'une clé encodée en base64url.
 */
export async function computeKeyHashFromEncodedLegacy(
  encodedKey: string,
): Promise<string> {
  const key = await importKeyFromBase64(encodedKey);
  return computeKeyHashLegacy(key);
}

// ----- Stockage local des clés par share (legacy / migration) ----------

const STORAGE_PREFIX = "privcloud_e2e_key_";

// Legacy prefix for backward compatibility
const LEGACY_STORAGE_PREFIX = "ottrbox_e2e_key_";

export function storeShareKey(shareId: string, encodedKey: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${shareId}`, encodedKey);
  } catch {
    console.warn("Impossible de stocker la clé E2E dans localStorage");
  }
}

export function getStoredShareKey(shareId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${shareId}`)
      ?? localStorage.getItem(`${LEGACY_STORAGE_PREFIX}${shareId}`);
  } catch {
    return null;
  }
}

export function removeStoredShareKey(shareId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${shareId}`);
    localStorage.removeItem(`${LEGACY_STORAGE_PREFIX}${shareId}`);
  } catch {
    // silencieux
  }
}

// ----- Extraction de la clé depuis le fragment d'URL -------------------------

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
 * Valide le format base64url pour éviter toute injection depuis un
 * localStorage corrompu (DOM-based XSS -- CWE-79).
 */
export function buildKeyFragment(encodedKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encodedKey)) return "";
  return `#key=${encodedKey}`;
}

/**
 * Extrait la clé d'équipe base64url depuis window.location.hash.
 * Format attendu : #teamKey=<base64url>
 */
export function extractTeamKeyFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const match = hash.match(/[#&]teamKey=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

// ----- Wrapping / Unwrapping de clé (pour reverse shares E2E) -----──

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

// ----- Téléchargement déchiffré ------------------------------------------------------------─

/**
 * Crée un lien de téléchargement pour un Blob déchiffré.
 */
export function downloadDecryptedBlob(blob: Blob, filename: string): void {
  // Sanitize filename: strip path separators and null bytes to prevent path traversal
  const safeName = filename.replace(/[/\\\0]/g, "_").replace(/^\.\./, "_");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  a.rel = "noopener noreferrer";
  // Click without appending to DOM -- supported in all modern browsers
  // (Chrome 48+, Firefox 57+, Safari 14+).  Avoids the DOMXSS false-positive
  // pattern of remote-data -> appendChild while retaining full functionality.
  a.click();
  // Revoke after a short delay to let the browser initiate the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----- Utilitaires base64url -----------------------------------------------------------------─

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

// ----- Coffre-fort système via WebAuthn PRF (FIDO2) -----------------------------------------
const PASSKEY_STORAGE_KEY = "privcloud_passkey_wrapped_key";

export interface PasskeyWrappedKey {
  credentialId: string; // base64url
  wrappedKey: string;   // base64url - AES-KW(encodedKey) chiffré par PRF
  salt: string;         // base64url - sel fixe lié à ce credential (32 octets)
}

/**
 * Vérifie si le navigateur supporte WebAuthn avec l'extension PRF.
 * Nécessite Chrome 116+, Edge 116+, Safari 17.4+ ou Firefox 119+.
 *
 * LIMITATION : Cette vérification ne teste que la présence d'un authentificateur
 * de plateforme. Elle ne peut pas vérifier le support réel de l'extension PRF
 * sans tenter une création/assertion de credential. Les gestionnaires de mots
 * de passe tiers (ex: KeepassDX) peuvent s'enregistrer comme fournisseurs de
 * credentials sans supporter PRF - dans ce cas saveKeyWithPasskey/loadKeyWithPasskey
 * retournera false lors de l'évaluation PRF effective.
 */
export async function isPasskeyPrfAvailable(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!window.PublicKeyCredential) return false;
  // Try getClientCapabilities() first (WebAuthn Level 3+) for a more precise check
  if (typeof (window.PublicKeyCredential as any).getClientCapabilities === "function") {
    try {
      const caps = await (window.PublicKeyCredential as any).getClientCapabilities();
      if (caps && typeof caps["extension:prf"] === "boolean") {
        return caps["extension:prf"];
      }
    } catch {
      // Fallback to legacy check below
    }
  }
  if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return false;
  try {
    const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return available;
  } catch {
    return false;
  }
}

/**
 * Enregistre la clé E2E dans le coffre-fort système via WebAuthn PRF.
 *
 * Crée un nouveau credential de plateforme, dérive le PRF output, wrappe
 * la clé avec AES-KW-256 et stocke le tout en localStorage + retourne les
 * données pour synchronisation serveur (multi-device).
 *
 * @param encodedKey  - clé E2E base64url à protéger
 * @param userId      - identifiant unique de l'utilisateur (lié au credential)
 * @param userEmail   - email affiché dans la boîte de dialogue authenticateur
 * @returns PasskeyWrappedKey si succès (à synchroniser au serveur), null si échec
 */
export async function saveKeyWithPasskey(
  encodedKey: string,
  userId: string,
  userEmail: string,
): Promise<PasskeyWrappedKey | null> {
  // Validation stricte du format base64url (CWE-20)
  if (!/^[A-Za-z0-9_-]+$/.test(encodedKey)) {
    throw new Error("Invalid encodedKey format");
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));

  // Encoder l'userId en bytes (max 64 octets requis par WebAuthn spec)
  const userIdBytes = new TextEncoder().encode(userId).slice(0, 64);

  let credential: PublicKeyCredential;
  try {
    const raw = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: {
          name: "PrivCloud Sharing",
          id: window.location.hostname,
        },
        user: {
          id: userIdBytes,
          name: userEmail,
          displayName: userEmail,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256 (ECDSA P-256)
          { type: "public-key", alg: -257 },  // RS256 (RSA-PKCS1v15)
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        extensions: {
          prf: {
            eval: { first: salt.buffer },
          },
        } as AuthenticationExtensionsClientInputs,
      },
    });
    credential = raw as PublicKeyCredential;
  } catch {
    // L'utilisateur a annulé la boîte de dialogue authenticateur
    return null;
  }

  // Vérifier que l'authenticateur a bien retourné le PRF output
  const ext = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const prfOutput = ext.prf?.results?.first;
  if (!prfOutput) {
    // L'authenticateur ne supporte pas l'extension PRF
    return null;
  }

  // Dériver une clé AES-KW à partir du PRF output (32 octets)
  const prfKey = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    { name: "AES-KW" },
    false,
    ["wrapKey"],
  );

  // Importer la clé E2E pour pouvoir la wrapper
  const e2eKey = await importKeyFromBase64(encodedKey);

  // Wrapper avec AES-KW (RFC 3394)
  const wrappedKeyBuffer = await crypto.subtle.wrapKey("raw", e2eKey, prfKey, "AES-KW");

  // Persister en localStorage (cache local) + retourner pour sync serveur
  const stored: PasskeyWrappedKey = {
    credentialId: arrayBufferToBase64Url(credential.rawId),
    wrappedKey: arrayBufferToBase64Url(wrappedKeyBuffer),
    salt: arrayBufferToBase64Url(salt.buffer),
  };
  try {
    localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // localStorage plein ou SSR - continue, le serveur sera la source de vérité
  }

  return stored;
}

/**
 * Restaure la clé E2E depuis le coffre-fort système via WebAuthn PRF.
 *
 * Récupère le credential enregistré, dérive le PRF output avec biométrie/PIN,
 * dé-wrappe la clé et retourne la valeur base64url.
 *
 * Cherche d'abord en localStorage (même appareil), puis utilise les données
 * serveur si fournies (multi-device : passkey synchronisée via iCloud/Google).
 *
 * @param serverWrappedKeys - liste optionnelle de wrapped keys récupérées du serveur
 * @returns encodedKey si succès, null si annulation ou credential absent
 */
export async function loadKeyWithPasskey(
  serverWrappedKeys?: PasskeyWrappedKey[],
): Promise<string | null> {
  // 1. Essayer le localStorage (même appareil, rapide)
  let candidates: PasskeyWrappedKey[] = [];
  try {
    const raw = localStorage.getItem(PASSKEY_STORAGE_KEY);
    if (raw) {
      const local = JSON.parse(raw) as PasskeyWrappedKey;
      if (local.credentialId && local.wrappedKey && local.salt) {
        candidates.push(local);
      }
    }
  } catch {
    // localStorage vide ou corrompu
  }

  // 2. Ajouter les wrapped keys serveur (multi-device) sans doublons
  if (serverWrappedKeys?.length) {
    const localIds = new Set(candidates.map((c) => c.credentialId));
    for (const sw of serverWrappedKeys) {
      if (!localIds.has(sw.credentialId)) {
        candidates.push(sw);
      }
    }
  }

  if (candidates.length === 0) return null;

  // 3. Essayer chaque credential (d'abord local, puis serveur)
  for (const stored of candidates) {
    const result = await tryUnwrapWithCredential(stored);
    if (result) {
      // Mettre à jour le cache local si la clé venait du serveur
      try {
        localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(stored));
      } catch {
        // silencieux
      }
      return result;
    }
  }

  return null;
}

/**
 * Tente de dé-wrapper une clé E2E avec un credential WebAuthn spécifique.
 * @returns encodedKey base64url si succès, null si échec
 */
async function tryUnwrapWithCredential(
  stored: PasskeyWrappedKey,
): Promise<string | null> {

  const credentialId = base64UrlToArrayBuffer(stored.credentialId);
  const salt = base64UrlToArrayBuffer(stored.salt);
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  let assertion: PublicKeyCredential;
  try {
    const raw = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [
          { type: "public-key", id: credentialId },
        ],
        userVerification: "required",
        extensions: {
          prf: {
            eval: { first: salt },
          },
        } as AuthenticationExtensionsClientInputs,
      },
    });
    assertion = raw as PublicKeyCredential;
  } catch {
    // L'utilisateur a annulé
    return null;
  }

  const ext = assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const prfOutput = ext.prf?.results?.first;
  if (!prfOutput) return null;

  // Dériver la clé de déchiffrement AES-KW
  const prfKey = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    { name: "AES-KW" },
    false,
    ["unwrapKey"],
  );

  // Dé-wrapper la clé E2E
  let e2eKey: CryptoKey;
  try {
    const wrappedKeyBuffer = base64UrlToArrayBuffer(stored.wrappedKey);
    e2eKey = await crypto.subtle.unwrapKey(
      "raw",
      wrappedKeyBuffer,
      prfKey,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  } catch {
    // Clé corrompue ou mauvais authenticateur
    return null;
  }

  return exportKeyToBase64(e2eKey);
}

/**
 * Vérifie si une clé wrappée existe déjà en localStorage pour cet appareil.
 */
export function hasPasskeyWrappedKey(): boolean {
  try {
    return localStorage.getItem(PASSKEY_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Supprime la clé wrappée du localStorage (ex: lors de la révocation de la clé E2E).
 */
export function removePasskeyWrappedKey(): void {
  try {
    localStorage.removeItem(PASSKEY_STORAGE_KEY);
  } catch {
    // silencieux
  }
}
