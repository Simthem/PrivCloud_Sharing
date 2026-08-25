/**
 * Normalize recipient input at the trust boundary.
 *
 * Email domains are case-insensitive and real-world mailboxes overwhelmingly
 * treat the local part the same way. We preserve the first submitted spelling
 * for display/delivery while deduplicating case-insensitively.
 */
export function normalizeShareRecipients(
  recipients: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawEmail of recipients ?? []) {
    const email = rawEmail.trim();
    const key = email.toLocaleLowerCase("en-US");
    if (!email || seen.has(key)) continue;
    seen.add(key);
    normalized.push(email);
  }

  return normalized;
}
