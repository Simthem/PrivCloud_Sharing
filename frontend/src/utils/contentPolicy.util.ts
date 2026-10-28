/**
 * The current bundle writes v2 and creates keys with a v2 floor. Runtime
 * settings can raise a minimum, never lower the minimum of this client.
 * Server switches govern whether older clients may still start v1 uploads.
 */
type ConfigEntry = {
  key: string;
  value?: string | null;
  defaultValue?: string | null;
};

export type ContentPolicy = {
  /** New files are written in v2. */
  v2Writes: boolean;
  /** New content keys carry a v2 floor. */
  v2Floor: boolean;
};

let current: ContentPolicy = { v2Writes: true, v2Floor: true };
let requiredByServer = false;

function enabled(configs: ConfigEntry[], key: string): boolean {
  const entry = configs.find((config) => config.key === key);
  return (entry?.value ?? entry?.defaultValue) === "true";
}

export function applyContentPolicy(configs?: ConfigEntry[] | null): void {
  if (!Array.isArray(configs)) return;
  current = {
    v2Writes:
      current.v2Writes ||
      requiredByServer ||
      enabled(configs, "share.contentV2Writes"),
    v2Floor:
      current.v2Floor ||
      requiredByServer ||
      enabled(configs, "share.contentV2Writes") ||
      enabled(configs, "share.contentV2Floor"),
  };
}

export function contentPolicy(): ContentPolicy {
  return current;
}

/**
 * The server refused a v1 upload because v2 writes are on. The page then
 * writes v2 for the rest of its life, whatever configuration it still holds.
 */
export function noteContentV2Required(): void {
  requiredByServer = true;
  current = { v2Writes: true, v2Floor: true };
}
