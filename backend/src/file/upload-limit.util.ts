export const ABSOLUTE_MAX_UPLOAD_CHUNK_BYTES = 200_000_000;
export const DEFAULT_MAX_UPLOAD_CHUNK_BYTES = 50_000_000;
export const DEFAULT_ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES = 35_000_000;
export const DEFAULT_AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES = 50_000_000;
export const MIN_ENCRYPTION_CHUNK_BYTES = 1_000_000;
export const ENCRYPTION_RECORD_OVERHEAD_BYTES = 28;

const parseChunkLimit = (
  rawValue: string | undefined,
  fallback: number,
  ceiling: number,
): number =>
  Math.min(
    ceiling,
    Math.max(1, Number.parseInt(rawValue ?? String(fallback), 10) || fallback),
  );

// The process-wide ceiling protects the HTTP parser and every internal upload
// path. Instance administrators may lower the public profiles, but no client
// or account type can raise this bound.
export const MAX_UPLOAD_CHUNK_BYTES = parseChunkLimit(
  process.env.UPLOAD_MAX_CHUNK_BYTES,
  DEFAULT_MAX_UPLOAD_CHUNK_BYTES,
  ABSOLUTE_MAX_UPLOAD_CHUNK_BYTES,
);

export const ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES = parseChunkLimit(
  process.env.UPLOAD_ANONYMOUS_MAX_CHUNK_BYTES,
  DEFAULT_ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
);

export const AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES = parseChunkLimit(
  process.env.UPLOAD_AUTHENTICATED_MAX_CHUNK_BYTES,
  DEFAULT_AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
);

export function getUploadChunkLimit(isAuthenticated: boolean): number {
  return isAuthenticated
    ? AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES
    : ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES;
}

export function getMaxUploadPayloadBytes(
  maxChunkBytes: number,
  declaredChunkSize = maxChunkBytes,
  encryptionChunkSize?: number,
): number {
  const plainBytes = Math.min(maxChunkBytes, declaredChunkSize);
  if (!encryptionChunkSize) return plainBytes;
  const recordCount = Math.ceil(plainBytes / encryptionChunkSize);
  return plainBytes + recordCount * ENCRYPTION_RECORD_OVERHEAD_BYTES;
}
