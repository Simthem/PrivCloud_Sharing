/**
 * The dot was forbidden in historical share identifiers. This namespace
 * therefore identifies a new context without trusting a database column.
 * It does not change the generation of the key used by that context.
 */
export function isContentV2ShareId(id: string): boolean {
  return /^v2\.[A-Za-z0-9_-]{3,47}$/.test(id);
}

export function contentV2ShareId(id: string): string {
  if (isContentV2ShareId(id)) return id;
  if (!/^[A-Za-z0-9_-]{3,50}$/.test(id)) {
    throw new Error("Invalid share identifier");
  }
  return `v2.${id.length <= 47 ? id : crypto.randomUUID()}`;
}

/** UUIDv8 is reserved by this client for files whose context requires v2. */
export function isContentV2FileId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

export function contentV2FileId(id: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new Error("Invalid file identifier");
  }
  return id.slice(0, 14) + "8" + id.slice(15);
}
