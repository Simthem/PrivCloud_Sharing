export type SigningIdentityAccount = {
  emailVerifiedAt: Date | null;
  ldapDN: string | null;
  oAuthUsers?: { provider: string }[];
};

export type SigningIdentityProof = {
  method: "VERIFIED_EMAIL_ACCOUNT" | "LDAP_ACCOUNT" | "OIDC_ACCOUNT";
  verifiedAt: Date;
};

/**
 * Resolve the account-level identity proof PrivCloud can honestly evidence
 * without claiming a state-issued or qualified civil identity.
 */
export function resolveSigningIdentityProof(
  user: SigningIdentityAccount,
  now = new Date(),
): SigningIdentityProof | null {
  if (user.ldapDN) {
    return { method: "LDAP_ACCOUNT", verifiedAt: now };
  }
  if (user.oAuthUsers?.length) {
    return { method: "OIDC_ACCOUNT", verifiedAt: now };
  }
  if (user.emailVerifiedAt) {
    return {
      method: "VERIFIED_EMAIL_ACCOUNT",
      verifiedAt: user.emailVerifiedAt,
    };
  }
  return null;
}
