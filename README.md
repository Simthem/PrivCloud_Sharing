# <div align="center"> </br>PrivCloud_Sharing</div>
<!-- <img  src="https://user-images.githubusercontent.com/58886915/166198400-c2134044-1198-4647-a8b6-da9c4a204c68.svg" width="40"/> -->

[![](https://dcbadge.limes.pink/api/server/hupa2vnUEu)](https://discord.gg/hupa2vnUEu) [![](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#white)](https://github.com/sponsors/Simthem)

---

PrivCloud_Sharing is a self-hosted file sharing platform and an alternative for WeTransfer.

## Features

- Share files using a link
- Unlimited file size (restricted only by disk space)
- Set an expiration date for shares
- Secure shares with visitor limits and passwords
- **End-to-end encryption (E2E)** - Files are encrypted client-side with AES-256-GCM before upload. The server never sees the encryption key.
- **E2E encrypted reverse shares** - Reverse share links include a per-share encryption key in the URL fragment. Senders encrypt files with that key, and only the reverse share creator can decrypt them.
- Email recipients
- Reverse shares
- OIDC and LDAP authentication
- Integration with ClamAV for security scans
- Different file providers: local storage and S3

## Security

PrivCloud_Sharing includes a hardened dependency tree with **zero known CVEs** across all three packages (backend, frontend, docs). Key upgrades:

- **Next.js 15** with `@ducanh2912/next-pwa` (replaces deprecated `next-pwa`)
- **NestJS 11** with **Prisma 6** and stricter type guards
- All transitive vulnerabilities resolved via targeted overrides

### End-to-End Encryption

PrivCloud_Sharing encrypts all uploaded files client-side using **AES-256-GCM** via the Web Crypto API.

- **User uploads**: A per-user master key (`K_master`) is generated on first upload and stored in the browser's `localStorage`. A SHA-256 hash of the key is stored server-side for verification - never the key itself. Share links include the key in the URL fragment (`#key=...`), which is never sent to the server.
- **Reverse share uploads**: When a user creates a reverse share, a per-reverse-share key (`K_rs`) is generated and encrypted with `K_master`. The encrypted key is stored server-side. The cleartext `K_rs` is appended to the reverse share link via the URL fragment. Senders use `K_rs` to encrypt their files. Only the reverse share owner can decrypt `K_rs` (using their `K_master`) to access the uploaded files.

## Get to know PrivCloud_Sharing

<img src="https://user-images.githubusercontent.com/58886915/225038319-b2ef742c-3a74-4eb6-9689-4207a36842a4.png" width="700"/>

## Setup

### Installation with Docker (recommended)

1. Download the `docker-compose.yaml` file
2. Run `docker compose up -d`

The website is now listening on `http://localhost:3000`, have fun with PrivCloud_Sharing!

### Proxy Configuration

If your server accesses the internet through an HTTP proxy, uncomment and edit the proxy lines in `docker-compose.yaml`:

```yaml
environment:
  - NODE_OPTIONS=--dns-result-order=ipv4first --require /opt/app/backend/node_modules/global-agent/bootstrap
  - GLOBAL_AGENT_HTTP_PROXY=http://your-proxy:3128
  - GLOBAL_AGENT_NO_PROXY=localhost,127.0.0.1,::1
  - HTTP_PROXY=http://your-proxy:3128
  - HTTPS_PROXY=http://your-proxy:3128
  - NO_PROXY=localhost,127.0.0.1,::1
```

If you are **building the image yourself** behind a proxy, also pass build args:

```yaml
build:
  context: .
  args:
    HTTP_PROXY: http://your-proxy:3128
    HTTPS_PROXY: http://your-proxy:3128
```

Node.js does not natively honor `HTTP_PROXY` / `HTTPS_PROXY` environment variables. PrivCloud_Sharing bundles [global-agent](https://github.com/gajus/global-agent) to patch `http.globalAgent` / `https.globalAgent` at runtime, so outbound requests (S3, external APIs) are properly routed through the proxy.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `TRUST_PROXY` | Set to `true` if a reverse proxy sits in front of the container | `false` |
| `CADDY_DISABLED` | Set to `true` to disable the built-in Caddy reverse proxy | `false` |
| `HTTP_PROXY` / `HTTPS_PROXY` | HTTP proxy URL for outbound connections | _(none)_ |
| `GLOBAL_AGENT_HTTP_PROXY` | Proxy URL for Node.js global-agent | _(none)_ |
| `GLOBAL_AGENT_NO_PROXY` | Comma-separated list of hosts to bypass proxy | _(none)_ |
| `NO_PROXY` | Comma-separated list of hosts to bypass proxy (system-level) | _(none)_ |

## Documentation

For more installation options and advanced configurations, please refer to the [documentation](https://stonith404.github.io/pingvin-share).

> This is a fork of [Pingvin Share](https://github.com/stonith404/pingvin-share) with some modifications since the original project is no longer maintained.
> The original project is licensed under the [BSD 2-Clause License](https://github.com/stonith404/pingvin-share/blob/main/LICENSE).
