import { OAuthCallbackDto } from "../dto/oauthCallback.dto";
import { OAuthSignInDto } from "../dto/oauthSignIn.dto";

/**
 * @typeParam T - type of token
 * @typeParam C - type of callback query
 */
export interface AuthEndpointResult {
  url: string;
  nonce?: string;
}

export interface AuthEndpointOptions {
  // Ask the provider to authenticate the user again, even with a session.
  reauthenticate?: boolean;
}

export interface OAuthProvider<T, C = OAuthCallbackDto> {
  getAuthEndpoint(
    state: string,
    options?: AuthEndpointOptions,
  ): Promise<AuthEndpointResult>;

  getToken(query: C): Promise<OAuthToken<T>>;

  getUserInfo(token: OAuthToken<T>, query: C): Promise<OAuthSignInDto>;
}

export interface OAuthToken<T> {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  idToken?: string;
  rawToken: T;
}
