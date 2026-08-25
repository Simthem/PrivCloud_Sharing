export const DEFAULT_REENCRYPT_TRANSPORT_CHUNK_SIZE = 50_000_000;
const REENCRYPT_CHUNK_QUANTUM = 1_000_000;

export function getRuntimeReencryptChunkSize(
  configs: { key: string; value?: string; defaultValue?: string }[],
): number {
  const runtime = configs.find(
    (config) => config.key === "runtime.uploadMaxChunkBytes",
  );
  const parsed = Number.parseInt(
    runtime?.value ?? runtime?.defaultValue ?? "",
    10,
  );
  if (!Number.isSafeInteger(parsed) || parsed < REENCRYPT_CHUNK_QUANTUM) {
    return DEFAULT_REENCRYPT_TRANSPORT_CHUNK_SIZE;
  }
  return Math.floor(parsed / REENCRYPT_CHUNK_QUANTUM) * REENCRYPT_CHUNK_QUANTUM;
}
