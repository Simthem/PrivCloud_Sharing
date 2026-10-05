/** Catch address typos before submission. The API remains authoritative. */
export const isValidSigningRecipientEmail = (value: string): boolean => {
  if (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return false;
  }
  const [local, domain] = value.split("@");
  const quoted = local.startsWith('"') && local.endsWith('"');
  if (
    local.length > 64 ||
    (!quoted &&
      (local.startsWith(".") || local.endsWith(".") || local.includes("..")))
  ) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.every((label) =>
      /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?$/u.test(
        label,
      ),
    ) && /^(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]+)$/iu.test(labels.at(-1) || "")
  );
};
