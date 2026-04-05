/**
 * Copy text to clipboard with fallback for iframe contexts.
 *
 * navigator.clipboard.writeText() requires the "clipboard-write"
 * Permissions-Policy which cross-origin (or even same-site) iframes
 * do not have by default. The legacy execCommand("copy") fallback
 * works in most browsers regardless of iframe policy.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern Clipboard API
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied -- fall through to legacy method
    }
  }

  // Legacy fallback via hidden textarea
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Keep it off-screen to avoid flash
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
