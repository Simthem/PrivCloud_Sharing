/**
 * A configured endpoint as it may appear in logs and evidence: no user,
 * password, query or fragment, which can carry credentials.
 */
export function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}
