/**
 * E2E Encryption utilities for PrivCloud_Sharing
 *
 * Algorithm: AES-256-GCM (Web Crypto API)
 * Encrypted file format: [IV 12 bytes][ciphertext + tag 16 bytes]
 * Key shared via the URL fragment (#key=<base64url>)
 *
 * The key is NEVER sent to the server.
 */

const IV_LENGTH = 12; // 96 bits, recommended for AES-GCM

// ----- Key generation ---------------------------------------------------------------------------

export async function generateEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable
    ["encrypt", "decrypt"],
  );
}

// ----- Key export / import (base64url) -----------------------------------------------

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

// ----- File encryption --------------------------------------------------------------------

/**
 * Encrypts an ArrayBuffer with AES-256-GCM.
 * Returns: [IV (12 bytes)][ciphertext + auth tag (16 bytes)]
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

  // Concatenate IV + ciphertext into a single buffer, then release
  // the intermediate ciphertext reference so GC can reclaim it.
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  ciphertext = null;

  return result.buffer;
}

// ----- File decryption --------------------------------------------------------------------

/**
 * Decrypts an ArrayBuffer with the format [IV][ciphertext+tag].
 * Returns the plaintext.
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
const ENCRYPTION_OVERHEAD = IV_LENGTH + GCM_TAG_LENGTH; // 28 bytes per chunk

/**
 * Decrypts a file composed of N independently encrypted chunks.
 * Each stored chunk = [IV 12][ciphertext + tag 16].
 * Encrypted chunk size = plaintextChunkSize + 28.
 *
 * Chunk size detection strategy:
 * 1. Try plaintextChunkSize (from config) per-chunk
 * 2. If that fails, try other plausible sizes (adaptive 5-200 MB)
 * 3. Last resort: single-block (backward compat with old uploads)
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
  // Deduplicate and keep only relevant sizes
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
    // Quick check: the first chunk must be decryptable
    try {
      await decryptFile(encrypted.slice(0, tryEnc), key);
    } catch {
      continue; // wrong size, try the next candidate
    }
    // First chunk decrypts successfully: decrypt the whole file with this size
    try {
      return await decryptPerChunk(encrypted, key, tryPlain);
    } catch {
      continue;
    }
  }

  throw new Error("E2E decryption failed: no matching chunk size found");
}

/** Decrypts a multi-chunk ArrayBuffer with a known chunk size. */
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
  // which is O(n^2) per encrypted chunk: for a 10 MB chunk with 64 KB
  // network fragments, ~780 MB of memcpy per chunk.  On a 43 GB file
  // that's 3+ TB of unnecessary copies.
  //
  // New approach: pre-allocate a buffer >= one encrypted chunk, append
  // fragments with a simple .set() at the fill position (O(fragment)),
  // and shift the remainder with .copyWithin() after each decrypt.
  // Total copy per chunk ~= chunkSize (unavoidable for WebCrypto) +
  // a small remainder shift -- roughly 78x less than before.
  const initialCap = Math.min(
    configChunkSize + ENCRYPTION_OVERHEAD + 65536,
    totalEncryptedSize + 1,
  );
  let buf = new Uint8Array(initialCap);
  let bufLen = 0;

  /** Append a network fragment to the pre-allocated buffer. */
  function append(data: Uint8Array) {
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
  function consume(n: number) {
    if (n >= bufLen) { bufLen = 0; return; }
    buf.copyWithin(0, n, bufLen);
    bufLen -= n;
  }

  /** Return a standalone ArrayBuffer copy suitable for WebCrypto. */
  function bufSlice(start: number, end: number): ArrayBuffer {
    return buf.slice(start, end).buffer;
  }

  /** Read from the stream until we have at least minBytes buffered. */
  async function fillBuffer(minBytes: number): Promise<boolean> {
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

// ----- User key storage (sessionStorage) ------------------------------------
// The E2E key is NEVER persisted via localStorage or a cookie.
// It lives in sessionStorage: it survives page reloads within the same tab
// but is cleared when the tab is closed.
//
// Why not a plain module variable? It would be lost on any page reload
// (F5, direct navigation), forcing the user to re-enter the key constantly.
//
// Why not localStorage? It persists indefinitely and can be read by
// any future XSS, even after logout.
//
// sessionStorage = a compromise: same XSS surface as a module variable
// during the active session, but better UX (survives reloads),
// and is automatically purged when the tab is closed.

const SESSION_STORAGE_ITEM = "privcloud_e2e_store";

export function storeUserKey(encodedKey: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_ITEM, encodedKey);
  } catch {
    // SSR or storage full -- silently ignore
  }
}

export function getUserKey(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_ITEM);
  } catch {
    return null;
  }
}

export function removeUserKey(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_ITEM);
  } catch {
    // silently ignore
  }
}

// ----- Key hash (HMAC-SHA256 hex) for server-side verification -----------

/**
 * Computes HMAC-SHA256(K_master, userId) as hex.
 * userId is used as the HMAC key, the raw bytes of the CryptoKey
 * serve as the message. This binds the hash to the user's identity
 * and prevents reuse of the same hash across accounts.
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
 * Computes HMAC-SHA256 hex from a base64url-encoded key.
 */
export async function computeKeyHashFromEncoded(
  encodedKey: string,
  userId: string,
): Promise<string> {
  const key = await importKeyFromBase64(encodedKey);
  return computeKeyHash(key, userId);
}

/**
 * Legacy SHA-256 hex from a base64url-encoded key.
 */
export async function computeKeyHashFromEncodedLegacy(
  encodedKey: string,
): Promise<string> {
  const key = await importKeyFromBase64(encodedKey);
  return computeKeyHashLegacy(key);
}

// ----- Per-share local key storage (legacy / migration) ----------------

const STORAGE_PREFIX = "privcloud_e2e_key_";

// Legacy prefix for backward compatibility
const LEGACY_STORAGE_PREFIX = "ottrbox_e2e_key_";

export function storeShareKey(shareId: string, encodedKey: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${shareId}`, encodedKey);
  } catch {
    console.warn("Failed to store E2E key in localStorage");
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

// ----- Key extraction from the URL fragment --------------------------------

/**
 * Extracts the base64url key from window.location.hash.
 * Expected format: #key=<base64url>
 */
export function extractKeyFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash) return null;

  const match = hash.match(/[#&]key=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Builds the #key=... fragment to append to a share URL.
 * Validates the base64url format to prevent injection from
 * a corrupted localStorage value (DOM-based XSS -- CWE-79).
 */
export function buildKeyFragment(encodedKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encodedKey)) return "";
  return `#key=${encodedKey}`;
}

// ----- Key wrapping / unwrapping (for E2E reverse shares) ---------------

/**
 * Encrypts K_rs with K_master (AES-GCM key wrapping).
 * Returns the encrypted key as base64url: [IV 12B][ciphertext+tag]
 *
 * Used when creating a reverse share:
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
 * Decrypts K_rs using K_master.
 * Takes the base64url value stored in the DB and returns the CryptoKey.
 *
 * Used by the owner to access files received via a reverse share.
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

// ----- Decrypted file download --------------------------------------------------------------

/**
 * Creates a download link for a decrypted Blob.
 */
export function downloadDecryptedBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to give the browser time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----- Utilitaires base64url ------------------------------------------------------------------

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
  // Restore standard base64
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding
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
