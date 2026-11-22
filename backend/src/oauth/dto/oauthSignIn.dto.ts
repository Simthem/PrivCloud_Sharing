export interface OAuthSignInDto {
  provider: "github" | "google" | "microsoft" | "discord" | "oidc";
  providerId: string;
  providerUsername: string;
  email: string;
  // Address the provider does not vouch for: mailbox proof is still required.
  unverifiedEmail?: string;
  // Only the domain is vouched for (Entra): enough to sign up, not to join an account.
  emailDomainOnly?: boolean;
  isAdmin?: boolean;
  idToken?: string;
  // OIDC auth_time (seconds), when the provider sends it.
  authTime?: number;
}
