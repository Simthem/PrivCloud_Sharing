import {
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  decryptFile,
  encryptFile,
} from "./crypto.util";

export type UploadResumeEntry = {
  shareId: string;
  fileId: string;
  name: string;
  relativePath?: string;
  size: number;
  lastModified: number;
  fingerprint: string;
  chunkSize: number;
  initialChunkSize: number;
  totalChunks: number;
  cryptoChunkSize: number;
  encryptedMetadata?: string;
  savedAt: number;
};
const PREFIX = "privcloud-upload-resume-v1:";
const MAX_AGE = 30 * 24 * 60 * 60_000;
const entriesByFile = new WeakMap<Blob, UploadResumeEntry>();
const storageKey = (shareId: string, fileId: string) =>
  PREFIX + encodeURIComponent(shareId) + ":" + fileId;
const aad = (shareId: string, fileId: string) =>
  new TextEncoder().encode(`PrivCloud upload resume v1:${shareId}:${fileId}`);

// A bounded check catches an accidentally reselected file without scanning
// hundreds of gigabytes before resuming. It is not a full-file integrity hash.
export async function fingerprintUploadFile(file: File): Promise<string> {
  const windowSize = 256 * 1024;
  const sample = new Blob([
    file.slice(0, windowSize),
    file.slice(Math.max(windowSize, file.size - windowSize)),
  ]);
  return arrayBufferToBase64Url(
    await crypto.subtle.digest("SHA-256", await sample.arrayBuffer()),
  );
}
export function getUploadResumeEntry(
  file: Blob,
  shareId: string,
): UploadResumeEntry | undefined {
  const entry = entriesByFile.get(file);
  return entry?.shareId === shareId ? entry : undefined;
}
export function attachUploadResumeEntry(
  file: Blob,
  entry: UploadResumeEntry,
): void {
  entriesByFile.set(file, entry);
}
export async function rememberUploadResumeEntry(
  file: Blob,
  entry: UploadResumeEntry,
  key: CryptoKey | null,
): Promise<void> {
  attachUploadResumeEntry(file, entry);
  if (!key) return;
  try {
    const encrypted = await encryptFile(
      new TextEncoder().encode(JSON.stringify(entry)).buffer,
      key,
      aad(entry.shareId, entry.fileId),
    );
    localStorage.setItem(
      storageKey(entry.shareId, entry.fileId),
      arrayBufferToBase64Url(encrypted),
    );
  } catch {
    /* A denied or full local store still permits an in-tab retry. */
  }
}
function validEntry(
  entry: UploadResumeEntry,
  shareId: string,
  fileId: string,
): boolean {
  return (
    entry?.shareId === shareId &&
    entry.fileId === fileId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      fileId,
    ) &&
    typeof entry.name === "string" &&
    typeof entry.fingerprint === "string" &&
    [
      entry.size,
      entry.lastModified,
      entry.chunkSize,
      entry.initialChunkSize,
      entry.totalChunks,
      entry.cryptoChunkSize,
      entry.savedAt,
    ].every(Number.isSafeInteger) &&
    entry.size >= 0 &&
    entry.chunkSize > 0 &&
    entry.initialChunkSize > 0 &&
    entry.initialChunkSize <= entry.chunkSize &&
    entry.cryptoChunkSize > 0 &&
    entry.cryptoChunkSize <= entry.chunkSize &&
    entry.totalChunks > 0 &&
    entry.totalChunks <= 10_000 &&
    entry.savedAt <= Date.now() &&
    Date.now() - entry.savedAt < MAX_AGE &&
    entry.totalChunks ===
      (entry.size > entry.chunkSize
        ? 1 + Math.ceil((entry.size - entry.initialChunkSize) / entry.chunkSize)
        : 1)
  );
}
export async function readUploadResumeEntries(
  shareId: string,
  key: CryptoKey,
): Promise<UploadResumeEntry[]> {
  const entries: UploadResumeEntry[] = [];
  const prefix = PREFIX + encodeURIComponent(shareId) + ":";
  try {
    const names = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((name): name is string => !!name && name.startsWith(prefix));
    for (const name of names) {
      const fileId = name.slice(prefix.length);
      try {
        const raw = localStorage.getItem(name);
        if (!raw || raw.length > 64_000) continue;
        const decrypted = await decryptFile(
          base64UrlToArrayBuffer(raw),
          key,
          aad(shareId, fileId),
        );
        const entry = JSON.parse(
          new TextDecoder().decode(decrypted),
        ) as UploadResumeEntry;
        if (validEntry(entry, shareId, fileId)) entries.push(entry);
        else if (
          Number.isSafeInteger(entry.savedAt) &&
          Date.now() - entry.savedAt >= MAX_AGE
        )
          localStorage.removeItem(name);
      } catch {
        /* Keys from another account and modified entries are rejected. */
      }
    }
  } catch {
    /* Browser persistence can be disabled. */
  }
  return entries.sort((left, right) => right.savedAt - left.savedAt);
}
export async function matchUploadResumeEntry(
  file: File,
  relativePath: string | undefined,
  entries: UploadResumeEntry[],
): Promise<UploadResumeEntry | undefined> {
  const candidates = entries.filter(
    (entry) =>
      entry.name === file.name &&
      entry.size === file.size &&
      entry.lastModified === file.lastModified &&
      (entry.relativePath || "") === (relativePath || ""),
  );
  if (candidates.length === 0) return undefined;
  const fingerprint = await fingerprintUploadFile(file);
  const candidate = candidates.find(
    (entry) => entry.fingerprint === fingerprint,
  );
  if (!candidate) return undefined;
  attachUploadResumeEntry(file, candidate);
  return candidate;
}
export function forgetUploadResumeEntry(file: Blob, shareId: string): void {
  const entry = getUploadResumeEntry(file, shareId);
  if (!entry) return;
  entriesByFile.delete(file);
  try {
    localStorage.removeItem(storageKey(shareId, entry.fileId));
  } catch {
    /* Optional. */
  }
}
