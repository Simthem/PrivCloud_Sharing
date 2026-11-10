// Title shown for a share its owner did not name: the first file it holds, read
// from what this client already has.

export type TitleFile = {
  name?: string;
  /** Set when the server only holds a placeholder for the name. */
  metadataScheme?: unknown;
  metadataUnreadable?: boolean;
};

/**
 * The first readable file name and how many other files the share holds, or
 * null while the names are still encrypted (`namesReadable` false) or when none can be read.
 */
export function defaultShareTitle(
  files: readonly TitleFile[] | undefined,
  namesReadable: boolean,
): { name: string; others: number } | null {
  if (!files?.length) return null;
  const first = files[0];
  if (first.metadataScheme != null && !namesReadable) return null;
  if (first.metadataUnreadable) return null;
  const name = first.name?.trim();
  if (!name) return null;
  return { name, others: files.length - 1 };
}
