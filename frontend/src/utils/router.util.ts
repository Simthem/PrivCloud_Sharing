export function safeRedirectPath(path: string | undefined) {
  if (!path) return "/";

  // Block protocol-relative URLs (//evil.com) and absolute URLs
  if (/^\/\//.test(path) || /^https?:/i.test(path)) return "/";

  if (!path.startsWith("/")) return "/";

  return path;
}
