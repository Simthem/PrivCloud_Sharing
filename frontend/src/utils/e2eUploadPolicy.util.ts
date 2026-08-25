export type PersonalE2EKeyAction =
  | "use-local-key"
  | "generate-first-key"
  | "restore-existing-key"
  | "upload-without-e2e";

/**
 * Resolve the only safe action for a classic authenticated upload.
 *
 * A server-side key hash without the corresponding key in this browser must
 * never trigger key generation: replacing that hash would make every share
 * encrypted with the previous key inaccessible.
 */
export function resolvePersonalE2EKeyAction(
  hasLocalKey: boolean,
  hasServerKey: boolean,
  autoGenerationDisabled = false,
): PersonalE2EKeyAction {
  // An explicit deletion always wins, including over a stale tab-local key.
  if (autoGenerationDisabled) return "upload-without-e2e";
  if (hasLocalKey) return "use-local-key";
  if (hasServerKey) return "restore-existing-key";
  return "generate-first-key";
}
