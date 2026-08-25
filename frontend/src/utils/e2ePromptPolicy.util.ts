type E2EPromptAccountState = {
  hasEncryptionKey?: boolean;
  hasTeamMembership?: boolean;
  e2eAutoGenerationDisabled?: boolean;
};

/**
 * Keep the explicit E2E opt-out authoritative. Deleting a key must not turn
 * into an endless setup prompt merely because the account belongs to a team.
 */
export function shouldPromptForE2EKey(
  user: E2EPromptAccountState,
  hasLocalKey: boolean,
): boolean {
  if (user.e2eAutoGenerationDisabled || hasLocalKey) return false;
  return !!user.hasEncryptionKey || !!user.hasTeamMembership;
}
