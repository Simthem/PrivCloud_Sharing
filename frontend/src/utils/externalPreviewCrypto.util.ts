import {
  decryptPrivateKey,
  getMyIdentityKeys,
  getMyPQKey,
  hybridUnwrapDEK,
  hybridWrapDEK,
} from "../services/crypto.service";

// Copies rendered for an external contractor. A random AES-256 preview key
// encrypts the manifest and each page image, and only the contractor's
// X25519 + ML-KEM-768 keys can unwrap it. The preview id and page index are
// authenticated data, so the server cannot swap pages or manifests.

export const EXTERNAL_WRAPPING_ALGORITHM = "x25519-mlkem768-aes256gcm";
export const EXTERNAL_MANIFEST_VERSION = 1;

export type ExternalKeyWrapping = {
  encryptedKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  kemCiphertext: string;
  algorithm: string;
};

export type ExternalManifestPage = {
  width: number;
  height: number;
  label?: string;
};

export type ExternalManifest = {
  v: typeof EXTERNAL_MANIFEST_VERSION;
  title: string;
  watermark: string;
  createdAt: string;
  pages: ExternalManifestPage[];
};

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const fromBase64Url = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const pageAad = (previewId: string, index: number) =>
  encoder.encode(`privcloud-external-page:v1:${previewId}:${index}`);
const manifestAad = (previewId: string) =>
  encoder.encode(`privcloud-external-manifest:v1:${previewId}`);

export function generatePreviewKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function importPreviewKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("Invalid preview key");
  return crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(key: CryptoKey, data: Uint8Array, aad: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad as Uint8Array<ArrayBuffer> },
      key,
      data as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv);
  out.set(ciphertext, iv.length);
  return out;
}

async function open(key: CryptoKey, payload: Uint8Array, aad: Uint8Array) {
  if (payload.length < 12 + 16) throw new Error("Invalid encrypted payload");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: payload.slice(0, 12),
        additionalData: aad as Uint8Array<ArrayBuffer>,
      },
      key,
      payload.slice(12),
    ),
  );
}

export function encryptExternalPage(
  key: CryptoKey,
  previewId: string,
  index: number,
  image: Uint8Array,
) {
  return seal(key, image, pageAad(previewId, index));
}

export function decryptExternalPage(
  key: CryptoKey,
  previewId: string,
  index: number,
  payload: Uint8Array,
) {
  return open(key, payload, pageAad(previewId, index));
}

export async function encryptExternalManifest(
  key: CryptoKey,
  previewId: string,
  manifest: ExternalManifest,
): Promise<string> {
  return toBase64Url(
    await seal(
      key,
      encoder.encode(JSON.stringify(manifest)),
      manifestAad(previewId),
    ),
  );
}

const isPage = (page: unknown): page is ExternalManifestPage => {
  const value = page as ExternalManifestPage;
  return (
    !!value &&
    Number.isInteger(value.width) &&
    Number.isInteger(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= 8192 &&
    value.height <= 8192 &&
    (value.label === undefined ||
      (typeof value.label === "string" && value.label.length <= 200))
  );
};

export async function decryptExternalManifest(
  key: CryptoKey,
  previewId: string,
  value: string,
  pageCount: number,
): Promise<ExternalManifest> {
  const manifest = JSON.parse(
    new TextDecoder().decode(
      await open(key, fromBase64Url(value), manifestAad(previewId)),
    ),
  ) as ExternalManifest;
  if (
    manifest?.v !== EXTERNAL_MANIFEST_VERSION ||
    typeof manifest.title !== "string" ||
    typeof manifest.watermark !== "string" ||
    typeof manifest.createdAt !== "string" ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length !== pageCount ||
    !manifest.pages.every(isPage)
  ) {
    throw new Error("Invalid preview manifest");
  }
  return manifest;
}

/** Wrap the preview key for a contractor: hybrid post-quantum, never X25519 alone. */
export async function wrapPreviewKeyForContractor(
  previewKey: Uint8Array,
  recipient: {
    x25519: { publicKey: string };
    pqKey: { publicKey: string; variant?: string };
  },
): Promise<ExternalKeyWrapping> {
  if ((recipient.pqKey.variant ?? "ML-KEM-768") !== "ML-KEM-768") {
    throw new Error("The contractor needs an ML-KEM-768 key");
  }
  const wrapped = await hybridWrapDEK(
    previewKey,
    recipient.x25519.publicKey,
    recipient.pqKey.publicKey,
  );
  if (wrapped.algorithm !== EXTERNAL_WRAPPING_ALGORITHM) {
    throw new Error("Unexpected key wrapping");
  }
  return {
    encryptedKey: wrapped.encryptedFileKey,
    ephemeralPublicKey: wrapped.ephemeralPublicKey,
    nonce: wrapped.nonce,
    kemCiphertext: wrapped.kemCiphertext,
    algorithm: wrapped.algorithm,
  };
}

/** Unwrap with raw private keys, see unwrapPreviewKey for the account flow. */
export async function unwrapPreviewKeyWith(
  wrapping: ExternalKeyWrapping,
  x25519PrivateKey: Uint8Array,
  mlkemPrivateKey: Uint8Array,
): Promise<CryptoKey> {
  if (wrapping.algorithm !== EXTERNAL_WRAPPING_ALGORITHM) {
    throw new Error("Unsupported key wrapping");
  }
  const raw = await hybridUnwrapDEK(
    {
      encryptedFileKey: wrapping.encryptedKey,
      ephemeralPublicKey: wrapping.ephemeralPublicKey,
      nonce: wrapping.nonce,
      kemCiphertext: wrapping.kemCiphertext,
    },
    x25519PrivateKey,
    mlkemPrivateKey,
  );
  return importPreviewKey(raw);
}

export type ContractorPrivateKeys = {
  x25519: Uint8Array;
  mlkem: Uint8Array;
};

/** The signed-in account's private keys, opened with its master key. */
export async function loadContractorPrivateKeys(
  masterKey: CryptoKey,
): Promise<ContractorPrivateKeys> {
  const [identityKeys, pqKey] = await Promise.all([
    getMyIdentityKeys(),
    getMyPQKey(),
  ]);
  const x25519 = identityKeys.find((key) => key.keyType === "X25519");
  if (!x25519 || !pqKey) throw new Error("Encryption keys unavailable");
  const [x25519PrivateKey, mlkemPrivateKey] = await Promise.all([
    decryptPrivateKey(x25519.encryptedPrivateKey, masterKey),
    decryptPrivateKey(pqKey.encryptedPrivateKey, masterKey),
  ]);
  return { x25519: x25519PrivateKey, mlkem: mlkemPrivateKey };
}

/** Open a preview key with the signed-in contractor's own keys. */
export async function unwrapPreviewKey(
  wrapping: ExternalKeyWrapping,
  keys: ContractorPrivateKeys,
): Promise<CryptoKey> {
  return unwrapPreviewKeyWith(wrapping, keys.x25519, keys.mlkem);
}
