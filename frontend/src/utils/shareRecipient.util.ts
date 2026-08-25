export function normalizeRecipientEmails(
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
