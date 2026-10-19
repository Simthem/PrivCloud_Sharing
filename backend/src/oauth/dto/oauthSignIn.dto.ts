export interface OAuthSignInDto {
  provider: "github" | "google" | "microsoft" | "discord" | "oidc";
  providerId: string;
  providerUsername: string;
  email: string;
  isAdmin?: boolean;
  idToken?: string;
  // OIDC auth_time (seconds), when the provider sends it.
  authTime?: number;
}
