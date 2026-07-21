// Every non-final S3 multipart part must be at least 5 MiB (5,242,880 bytes).
// Six decimal MB keeps the size divisible by the 1 MB crypto record while
// staying safely above that hard S3 boundary.
export const ADAPTIVE_MIN_CHUNK = 6_000_000;
// Normal transfers stay at or below 50 MB. Very large files may exceed this
// solely to remain below the S3 multipart part-count ceiling.
export const ADAPTIVE_MAX_CHUNK = 50_000_000;
export const ABSOLUTE_MAX_CHUNK = 200_000_000;
export const MAX_S3_PARTS = 9_500;
// One megabyte divides every 5 MB adaptive transport chunk, so records never
// end early at an internal transport boundary. It also keeps slow-download
// time-to-first-decrypted-byte low.
export const E2E_CRYPTO_RECORD_SIZE = 1_000_000;

const TARGET_CHUNK_SECONDS = 3;
const CHUNK_QUANT = 1_000_000;

export function computeAdaptiveChunkSize(bandwidthBps: number): number {
  if (bandwidthBps <= 0) return 0;
  const raw = bandwidthBps * TARGET_CHUNK_SECONDS;
  const clamped = Math.min(
    ADAPTIVE_MAX_CHUNK,
    Math.max(ADAPTIVE_MIN_CHUNK, raw),
  );
  return Math.round(clamped / CHUNK_QUANT) * CHUNK_QUANT;
}

export function computeEffectiveChunkSize(
  baseChunkSize: number,
  bandwidthBps: number,
  fileSize?: number,
): number {
  const hardCapped = Math.min(baseChunkSize, ADAPTIVE_MAX_CHUNK);
  const adaptive = computeAdaptiveChunkSize(bandwidthBps);
  let result = adaptive <= 0 ? hardCapped : adaptive;

  if (fileSize && fileSize > 0) {
    const s3Floor = Math.ceil(fileSize / MAX_S3_PARTS);
    if (s3Floor > result) {
      result = Math.ceil(s3Floor / CHUNK_QUANT) * CHUNK_QUANT;
    }
  }

  return Math.min(ABSOLUTE_MAX_CHUNK, Math.max(ADAPTIVE_MIN_CHUNK, result));
}
