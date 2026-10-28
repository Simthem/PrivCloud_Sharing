---
id: oauth2login
---

# OAuth 2 Login Guide

## Config Built-in OAuth 2 Providers

- [GitHub](#github)
- [Google](#google)
- [Microsoft](#microsoft)
- [Discord](#discord)
- [OpenID Connect](#openid-connect)

### GitHub

Please follow the [official guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) to create an OAuth app.

Redirect URL: `https://<your-domain>/api/oauth/callback/github`

### Google

Please follow the [official guide](https://developers.google.com/identity/protocols/oauth2/web-server#prerequisites) to create an OAuth 2.0 App.

Redirect URL: `https://<your-domain>/api/oauth/callback/google`

### Microsoft

Please follow the [official guide](https://docs.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app) to register an application.

> [!IMPORTANT] > **Microsoft Tenant** you set in the admin panel must match the **supported account types** you set in the Microsoft Entra admin center, otherwise the OAuth login will not work. Refer to the [official documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc#find-your-apps-openid-configuration-document-uri) for more details.

Redirect URL: `https://<your-domain>/api/oauth/callback/microsoft`

### Discord

Create an application on [Discord Developer Portal](https://discord.com/developers/applications).

Redirect URL: `https://<your-domain>/api/oauth/callback/discord`

### OpenID Connect

Generic OpenID Connect provider is also supported, we have tested it on Keycloak, Authentik, Casdoor and [Pocket ID](https://github.com/stonith404/pocket-id).

Redirect URI: `https://<your-domain>/api/oauth/callback/oidc`

Post Logout Redirect URI: `https://<your-domain>`

## Troubleshooting ID-token verification

The generic browser error page returns HTTP 500 by design. The backend's first
OAuth error identifies the failing step. Replacing the client secret does not
repair a failure to retrieve public signing keys or validate token claims.

Google accepts the two issuer values `https://accounts.google.com` and
`accounts.google.com`, as documented in its
[ID-token validation guide](https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken).
Custom OIDC providers still require their exact discovery issuer.

Discovery and token exchange use `fetch`. JOSE v4 retrieves JWKS with
`node:https`, so the backend explicitly supplies a verified HTTPS agent using
`GLOBAL_AGENT_HTTPS_PROXY`, `GLOBAL_AGENT_HTTP_PROXY`, `HTTPS_PROXY`, `https_proxy`,
`HTTP_PROXY` or `http_proxy`, in that order. The combined `GLOBAL_AGENT_NO_PROXY`,
`NO_PROXY` and `no_proxy` exclusions select direct connections. A proxy failure
never triggers a direct retry. Certificates and hostnames remain verified.

After rebuilding and redeploying, ID-token failures include a safe category:

- `claim_iss_invalid` or `claim_aud_invalid`: compare the provider and client-ID
  configuration with the working environment.
- `token_expired`: check the container host's clock and token freshness.
- `jwks_dns_failed`, `jwks_connection_failed` or `jwks_timeout`: check DNS,
  outbound proxy policy and reachability of the discovery document's `jwks_uri`.
- `jwks_tls_failed`: check the trusted CA bundle and any outbound TLS interception.
- `signature_invalid`, `signing_key_not_found`, `jwks_invalid`,
  `token_or_jwks_invalid` or `key_retrieval_failed`: inspect the provider's key
  endpoint and the deployed version. These categories intentionally omit raw
  token data and upstream error messages.

When preproduction works and production fails, compare immutable image IDs,
proxy settings, exclusions, CA trust and host clock before changing credentials.
No database migration is needed for this correction. A fresh real Google login
in each deployed web/native environment remains the final deployment check.
The local Node 24 reproduction also shows that the installed `global-agent`
4.1.3 can omit the destination TLS SNI when used as Node's HTTPS agent. This
can fail against a shared TLS endpoint even after Squid returns
`TCP_TUNNEL/200`. The explicit JWKS agent preserves SNI and consumes the full
CONNECT response, including responses split across network reads. Regression
fixtures require SNI and use fragmented CONNECT replies.

The 19 October Undici bump changed 7.29.1 to 7.30.1. The lockfile kept
`global-agent` at 4.1.3 and JOSE at 4.15.9. JWKS retrieval uses Node HTTPS rather
than Undici, and the corrected flow passes with Undici 7.30.1. These facts do not
by themselves prove which transport detail caused a particular production failure.

Never include client secrets, authorization codes, cookies or tokens in reports.

## Custom your OAuth 2 Provider

If our built-in providers don't meet your needs, you can create your own OAuth 2 provider.

### 1. Create config

Add your config (client id, client secret, etc.) in [`config.seed.ts`](https://github.com/stonith404/pingvin-share/blob/main/backend/prisma/seed/config.seed.ts):

```ts
const configVariables: ConfigVariables = {
  // ...
  oauth: {
    // ...
    "YOUR_PROVIDER_NAME-enabled": {
      type: "boolean",
      defaultValue: "false",
    },
    "YOUR_PROVIDER_NAME-clientId": {
      type: "string",
      defaultValue: "",
    },
    "YOUR_PROVIDER_NAME-clientSecret": {
      type: "string",
      defaultValue: "",
      obscured: true,
    },
  },
};
```

### 2. Create provider class

#### Generic OpenID Connect

If your provider supports OpenID connect, it's extremely easy to extend [`GenericOidcProvider`](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/provider/genericOidc.provider.ts) to add a new OpenID Connect provider.

The [Google provider](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/provider/google.provider.ts) and [Microsoft provider](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/provider/microsoft.provider.ts) are good examples.

Here are some discovery URIs for popular providers:

- Microsoft: `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`
- Google: `https://accounts.google.com/.well-known/openid-configuration`
- Apple: `https://appleid.apple.com/.well-known/openid-configuration`
- Gitlab: `https://gitlab.com/.well-known/openid-configuration`
- Huawei: `https://oauth-login.cloud.huawei.com/.well-known/openid-configuration`
- Paypal: `https://www.paypal.com/.well-known/openid-configuration`
- Yahoo: `https://api.login.yahoo.com/.well-known/openid-configuration`

#### OAuth 2

If your provider only supports OAuth 2, you can implement [`OAuthProvider`](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/provider/oauthProvider.interface.ts) interface to add a new OAuth 2 provider.

The [GitHub provider](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/provider/github.provider.ts) and [Discord provider](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/provider/discord.provider.ts) are good examples.

### 3. Register provider

Register your provider in [`OAuthModule`](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/oauth.module.ts) and [`OAuthSignInDto`](https://github.com/stonith404/pingvin-share/blob/main/backend/src/oauth/dto/oauthSignIn.dto.ts):

```ts
@Module({
  providers: [
    GitHubProvider,
    // your provider
    {
      provide: "OAUTH_PROVIDERS",
      useFactory(
        github: GitHubProvider /* your provider */
      ): Record<string, OAuthProvider<unknown>> {
        return {
          github,
          /* your provider */
        };
      },
      inject: [GitHubProvider /* your provider */],
    },
  ],
})
export class OAuthModule {}
```

```ts
export interface OAuthSignInDto {
  provider:
    | "github"
    | "google"
    | "microsoft"
    | "discord"
    | "oidc" /* your provider*/;
  providerId: string;
  providerUsername: string;
  email: string;
}
```

### 4. Add frontend icon

Add an icon in [`oauth.util.tsx`](https://github.com/stonith404/pingvin-share/blob/main/frontend/src/utils/oauth.util.tsx).

```tsx
const getOAuthIcon = (provider: string) => {
  return {
    github: <SiGithub />,
    /* your provider */
  }[provider];
};
```

### 5. Add i18n text

Add keys below to your i18n text in [locale file](https://github.com/stonith404/pingvin-share/blob/main/frontend/src/i18n/translations/en-US.ts).

- `signIn.oauth.YOUR_PROVIDER_NAME`
- `account.card.oauth.YOUR_PROVIDER_NAME`
- `admin.config.oauth.YOUR_PROVIDER_NAME-enabled`
- `admin.config.oauth.YOUR_PROVIDER_NAME-client-id`
- `admin.config.oauth.YOUR_PROVIDER_NAME-client-secret`
- `error.param.provider_YOUR_PROVIDER_NAME`
- Other config keys you defined in step 1

Congratulations! 🎉 You have successfully added a new OAuth 2 provider! Pull requests are welcome if you want to share your provider with others.
