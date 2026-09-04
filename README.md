# PrivCloud Sharing

[![](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=white)](https://github.com/sponsors/Simthem)

PrivCloud Sharing is a self-hosted, end-to-end encrypted file sharing platform
for private uploads, reverse shares, team workspaces, WebDAV imports and
eIDAS-oriented PDF signing.

This public edition is designed for open-source self-hosting. Collaboration
limits are controlled by instance configuration, not by hard-coded tiers.

## What Is Included

- Link-based file sharing with expiration dates, visitor limits and passwords.
- Authenticated and anonymous reverse shares.
- Client-side AES-256-GCM encryption before upload.
- E2E encrypted reverse-share uploads with per-link keys in URL fragments.
- Team workspaces with shared folders, member management and access logs.
- Granular team permissions for folders, files, downloads, deletes, E2E sharing
  and signature requests.
- Team notification feed with unread counts, Web Push and encrypted metadata.
- Per-member push preferences: all file events or direct shares only.
- E2EE identity keys, access grants, enrollment tokens and ML-KEM public-key
  metadata for post-quantum-ready key exchange plumbing.
- Electronic PDF signing with standard e-mail verification or reinforced
  WebAuthn confirmation, multi-signer order, approvers, CC recipients,
  tamper-evident audit trails and PAdES-B-B/PAdES-B-T signing support.
- Public signing links for external recipients without account registration;
  OTP is required before previewing, signing, rejecting or downloading PDFs.
- E2E signing links keep their decryption key in the URL fragment, including
  encrypted Team notification actions and final signed-file downloads.
- WebDAV/Nextcloud import from the upload page for authenticated users.
- Server-side HTTPS WebDAV proxy for browsers and mobile devices blocked by
  CORS or Private Network Access restrictions.
- Optional local PrivCloud Companion for managed WebDAV uploads and Native
  Messaging integrations.
- Browser, Thunderbird, Outlook, Google Workspace and desktop integration
  scaffolds.
- OIDC and LDAP authentication.
- ClamAV integration for uploaded-file scanning.
- Local filesystem and S3-compatible storage providers.
- Video preview and text/code previews where browser memory allows.
- Server-controlled adaptive upload windows with fair sharing between active
  files, bounded resource pressure, distributed idempotent finalization and
  S3-backed multipart recovery after an application restart or replacement.
- Ordered parallel S3 range downloads with bounded memory and byte-accurate
  browser resume for individual files, including E2E streams.

## Versioning

Public `v1.24.0` adds the direct and resumable transfer pipeline, stronger
session and outbound-request protections, Companion integration and
privacy-preserving administration. It remains a self-hosted open-source
release: transfer limits are instance settings and are not tied to a commercial
plan or payment service.

See [CHANGELOG.md](./CHANGELOG.md) for the full list of features, fixes and CVE
patches included in the public release.

## Security Model

### End-To-End Encryption

Files are encrypted client-side using AES-256-GCM through the Web Crypto API.

- User uploads create or reuse a per-user master key stored in the browser.
  The server stores only verification metadata, never the cleartext key.
- Share links carry the decryption key in the URL fragment (`#key=...`), which
  browsers do not send to the server.
- Reverse shares generate a per-reverse-share key. The owner keeps an encrypted
  copy server-side and senders encrypt files with the key from the link
  fragment.
- Team sharing uses encrypted access grants so each recipient receives an
  encrypted copy of the file key.
- The public crypto layer stores X25519/Ed25519 identity keys and ML-KEM-768
  public-key metadata. Team administrators can explicitly enable hybrid
  ML-KEM/X25519 encryption for notification actions.

### Public Signing Links

Signing URLs are public no-login recipient flows. Standard requests verify
mailbox control with a short-lived e-mail code; reinforced requests bind the
decision to an authenticated account and a fresh WebAuthn assertion. Signing
API and PDF responses set no-store and noindex headers to reduce accidental
indexing and caching.

### WebDAV And Companion

The server-side WebDAV proxy requires authentication, accepts HTTPS targets only,
rejects credentials embedded in URLs, refuses explicit private IP literals and
keeps target resources on the configured WebDAV origin.

PrivCloud Companion runs locally on the user's device. It receives a local
browser token and a short-lived share-scoped Bridge upload token, never the web
app cookies. WebDAV credentials are kept in memory for the active job.

### Dependency Hardening

The Docker build and package manifests include targeted security pins and
overrides. Current hardening includes:

- OpenSSL 3.6.4 branch-snapshot runtime, with exact artifact checks, dynamic
  Node linkage validation in cache mode and compile-time validation in full
  source mode, for CVE-2026-2673.
- Caddy built from source with patched Go dependencies.
- Go 1.26.5 builder stages.
- `golang.org/x/sys@v0.47.0` for CVE-2026-39824 scanner findings.
- Backend `brace-expansion>=5.0.6` for CVE-2026-45149.
- Backend and docs `qs>=6.15.2` for the Dependabot `qs#67` advisory.
- Pinned overrides for vulnerable transitive packages used by backend,
  frontend, docs and Docker-bundled npm tooling.

## Quick Start

### Docker Compose

1. Copy or edit `docker-compose.yaml`.
2. Set `APP_URL` to the public URL of your instance.
3. Set the signing certificate variables if you want PDF signing.
4. Start the service:

```bash
docker compose up -d
```

By default the compose example binds the application to
`127.0.0.1:3000`. Put a reverse proxy such as Caddy, Nginx or Traefik in front
of it for public HTTPS traffic.

Compose persists its SQLite database in the repository-level
`./data/pingvin-share.db`. A plain `npx prisma migrate deploy` launched from
`backend/` targets the separate development database at
`backend/data/pingvin-share.db`. To migrate the Compose database explicitly,
use the unambiguous root command:

```bash
npm run db:compose:migrate
```

### Local Development Build

```bash
docker compose build
docker compose up -d
```

The default `Dockerfile` can use prebuilt OpenSSL/Node builder cache images via
these build args:

```bash
docker build \
  --build-arg OPENSSL_BUILDER_IMAGE=simthem/privcloud-sharing:openssl-builder-cache \
  --build-arg NODE_BUILDER_IMAGE=simthem/privcloud-sharing:node-builder-cache \
  -t privcloud-sharing:local .
```

If you want to rebuild the heavy OpenSSL and Node stages from source, use
`Dockerfile.full-build`:

```bash
docker build -f Dockerfile.full-build -t privcloud-sharing:full-build .
```

That path is slower but useful for reproducibility audits and cache refreshes.

## Configuration

Common environment variables:

| Variable | Description | Default |
|---|---|---|
| `APP_URL` | Public URL used in emails, signing links and integrations | _(required for production)_ |
| `TRUST_PROXY` | Set to `true` when the container is behind a reverse proxy | `false` |
| `CADDY_DISABLED` | Disable the built-in Caddy reverse proxy | `false` |
| `TEAM_MAX_MEMBERS` | Max members per team, `0` means unlimited | `30` in compose example |
| `TEAM_MAX_OWNED_TEAMS` | Max teams a user can own, `0` means unlimited | `0` |
| `TEAM_MAX_FOLDERS` | Max shared folders per team, `0` means unlimited | `10` in compose example |
| `TEAM_MAX_SHARE_SIZE` | Max bytes per team share, unset or `0` means unlimited | _(none)_ |
| `TEAM_TOTAL_STORAGE_BYTES` | Total bytes per team, unset or `0` means unlimited | _(none)_ |
| `NODE_MAX_OLD_SPACE_SIZE` | Backend V8 heap size in MB | `3072` |
| `UPLOAD_MAX_CHUNK_BYTES` | Process-wide upload chunk safety ceiling | `50000000` |
| `UPLOAD_ANONYMOUS_MAX_CHUNK_BYTES` | Max accepted upload chunk body size without an authenticated account | `35000000` |
| `UPLOAD_AUTHENTICATED_MAX_CHUNK_BYTES` | Max accepted upload chunk body size for authenticated users | `50000000` |
| `S3_PROXY_URL` | Optional dedicated proxy for public S3 endpoints; `NO_PROXY` remains authoritative | _(none)_ |
| `S3_MAX_CONCURRENT_UPLOADS` | Adaptive global UploadPart ceiling | `6` |
| `S3_MIN_CONCURRENT_UPLOADS` | Minimum upload window under resource pressure | `2` |
| `S3_MAX_CONCURRENT_PER_FILE` | Maximum slots one otherwise-idle file can borrow | `6` |
| `S3_MAX_CONCURRENT_DOWNLOADS` | Adaptive global S3 range-read ceiling | `6` |
| `S3_MAX_CONCURRENT_PER_DOWNLOAD` | Maximum range reads for one large download | `6` |
| `S3_HTTP_SOCKET_BUFFER_BYTES` | Bounded high-water mark for the explicit production proxy transport | `1048576` |
| `AWS_REQUEST_CHECKSUM_CALCULATION` | SDK request checksum policy; `WHEN_REQUIRED` avoids the optional single-threaded CRC32 transform | `WHEN_REQUIRED` |
| `AWS_RESPONSE_CHECKSUM_VALIDATION` | SDK response checksum policy; required checks remain enabled without optional CRC validation | `WHEN_REQUIRED` |
| `S3_DIRECT_BROWSER_UPLOAD_ENABLED` | Authorize short-lived, exact-length browser `UploadPart` URLs and fall back idempotently to the Nest relay when the endpoint/CORS is unavailable | `false` |
| `S3_DIRECT_BROWSER_UPLOAD_ADDRESSING_MODE` | Browser upload addressing: `path`, `virtual-host` or `dual` | `path` |
| `S3_DIRECT_BROWSER_CONNECTIONS_PER_ORIGIN` | Maximum HTTP/1.1 upload requests assigned to each browser-visible S3 origin | `6` |
| `S3_DIRECT_BROWSER_MAX_CONCURRENCY` | Safety ceiling across all direct upload parts in one browser page; the effective value is also bounded by the available origins | `32` |
| `S3_DIRECT_BROWSER_UPLOAD_ENDPOINTS` | Up to four optional comma-separated, browser-visible HTTPS S3 endpoints/CNAMEs that target the same account and bucket | _(none)_ |
| `S3_DIRECT_BROWSER_URL_TTL_SECONDS` | Lifetime of one exact-part signed URL (bounded to 60–900 seconds) | `300` |
| `S3_DIRECT_BROWSER_DOWNLOAD_ENABLED` | Authorize one-object direct browser GETs while keeping access checks, counters, notifications and Team audit in Nest | `false` |
| `S3_DIRECT_BROWSER_DOWNLOAD_MAX_CONCURRENCY` | Maximum direct S3 ranges fetched concurrently, bounded to six per signed origin and by the browser buffer | `24` |
| `S3_DIRECT_BROWSER_DOWNLOAD_PART_BYTES` | Direct-browser range size; E2E ranges are aligned to encryption records | `33554432` |
| `S3_DIRECT_BROWSER_DOWNLOAD_THRESHOLD_BYTES` | File size from which the streaming direct-browser path uses parallel ranges | `67108864` |
| `S3_DIRECT_BROWSER_DOWNLOAD_MAX_BUFFER_BYTES` | Hard cap for completed out-of-order ranges in browser memory | `201326592` |
| `S3_DIRECT_BROWSER_DOWNLOAD_URL_TTL_SECONDS` | Lifetime of a resumable direct GET URL (bounded to 60–3600 seconds) | `900` |
| `S3_ALLOW_OPTIONAL_CHECKSUMS` | Explicit opt-in required before optional SDK checksums can be enabled | `false` |
| `S3_ADAPTIVE_PRESSURE_SAMPLES` | Consecutive CPU/event-loop pressure samples required before reducing the window | `3` |
| `S3_PARALLEL_DOWNLOAD_ENABLED` | Aggregate ordered S3 ranges for large full-file downloads | `true` |
| `S3_DOWNLOAD_PART_BYTES` | S3 download range size | `16777216` |
| `S3_HEALTH_TIMEOUT_MS` | Timeout for the readiness probe using the real S3 data-plane client | `10000` |
| `S3_DOWNLOAD_MAX_BUFFER_BYTES` | Per-flow download prefetch memory ceiling | `134217728` |
| `S3_MULTIPART_RECOVERY_ENABLED` | Recover multipart state from S3 after an application restart or replacement | `true` |
| `S3_MULTIPART_STALE_ABORT_HOURS` | Minimum S3 age before a demonstrably orphaned multipart may be aborted | `48` |
| `SIGNING_CERTIFICATE_PATH` | Path to P12/PFX signing certificate | _(none)_ |
| `SIGNING_CERTIFICATE_PASSWORD` | Password for the signing certificate | _(none)_ |
| `SIGNING_TSA_URL` | RFC 3161 timestamp authority URL | optional |
| `HTTP_PROXY` / `HTTPS_PROXY` | System proxy for outbound traffic | _(none)_ |
| `GLOBAL_AGENT_HTTP_PROXY` | Node.js global-agent proxy URL | _(none)_ |
| `GLOBAL_AGENT_NO_PROXY` / `NO_PROXY` | Hosts that bypass the proxy | _(none)_ |

With `dual`, a path-style endpoint
`https://<region-endpoint>/<bucket>/…` and virtual-host endpoint
`https://<bucket>.<region-endpoint>/…` form two distinct browser origins. Six
HTTP/1.1 connections per origin provide a 12-request page window without
raising the usual six-connection pool on either origin. Optional CNAMEs must
resolve to the same S3-compatible storage service and bucket and use a valid
TLS certificate; virtual-host-style custom domains may also require wildcard
DNS and TLS configuration. Consult the storage provider's addressing and CORS
documentation before exposing an additional browser origin.

Configure the S3 bucket CORS policy with the exact public application origin
(never `*` when the deployment can avoid it), methods `PUT`, `GET` and `HEAD`,
and the request headers required by the storage provider. Expose `ETag`,
`Content-Length`, `Content-Range`, `Content-Disposition` and `Content-Type`;
direct ranged download resumption needs `Content-Range`. Every additional
browser-visible S3 origin must also be allowed by the application's CSP
`connect-src` when a strict CSP is deployed.

Successful direct uploads and downloads keep large bodies off Nest, SafeLine
and the application server NIC. Authentication, configured size limits,
authorization and idempotent finalization remain server-side. The 12-upload
window belongs to one browser page and is shared by that page's active files;
it is not a global
cluster scheduler. Each browser therefore keeps an independent direct window,
while actual and aggregate throughput still depends on client hardware, the
network and S3 endpoint capacity.

`ETag` is diagnostic only for uploads: the backend finalizes from S3's
authoritative `ListParts` response. A transient failure opens a circuit breaker
only for the affected origin/candidate; the page can keep using the healthy
origin. The Worker switches the part to the Nest relay only after a durable
CORS/protocol incompatibility or when no direct candidate remains. The part
number is safely replaced, not duplicated, and relay concurrency stays
separate behind the server's adaptive slots, queues and memory limits.

`UPLOAD_MAX_CHUNK_BYTES` is the process-wide safety ceiling. Each effective
anonymous or authenticated limit is the lower of that ceiling and its profile
value. Raise both explicitly when testing a profile above 50 MB; `/api/configs`
publishes the result, and the backend independently enforces it on every
request. Keep reverse-proxy request-body ceilings above the selected value as
well; the application still rejects streams above its configured profile.

For production, also configure SMTP, OIDC/LDAP, storage provider settings,
ClamAV and legal pages from the admin UI or generated configuration.

## Proxy Support

If the server reaches the internet through an HTTP proxy, set both the system
proxy variables and the Node.js global-agent variables:

```yaml
environment:
  - NODE_OPTIONS=--dns-result-order=ipv4first --require /opt/app/backend/node_modules/global-agent/bootstrap
  - GLOBAL_AGENT_HTTP_PROXY=http://your-proxy:3128
  - GLOBAL_AGENT_NO_PROXY=localhost,127.0.0.1,::1
  - HTTP_PROXY=http://your-proxy:3128
  - HTTPS_PROXY=http://your-proxy:3128
  - NO_PROXY=localhost,127.0.0.1,::1
```

If you build the image behind a proxy, pass build args too:

```yaml
build:
  context: .
  args:
    HTTP_PROXY: http://your-proxy:3128
    HTTPS_PROXY: http://your-proxy:3128
```

## WebDAV And PrivCloud Companion

The upload page can import files from WebDAV/Nextcloud accounts.

- The server-side WebDAV proxy works across desktop and mobile browsers.
- PrivCloud Companion is optional and runs locally on the client device for
  managed large imports, local encryption and Native Messaging integrations.
- The Docker image exposes install assets under `/install/...` when built with
  the integration sources.

Companion source and setup notes live in [bridge/README.md](./bridge/README.md).

## Integrations

The `integrations/` folder contains publishable scaffolds:

- browser extension;
- Thunderbird extension;
- Outlook add-in;
- Google Workspace add-on;
- Windows and macOS Native Messaging registration helpers.

Generate versioned, instance-bound artifacts and their checksums with:

```bash
npm run build:companion
npm run build:integrations -- --base-url https://share.your-domain.example
```

To generate everything in one pass:

```bash
PRIVCLOUD_BASE_URL=https://share.your-domain.example npm run build:client-tools
```

Only browser, mail and desktop Companion artifacts are produced. Review
[integrations/PUBLISHING.md](./integrations/PUBLISHING.md) before publishing
them.

## Electronic Signature Setup

PDF signing requires a P12/PFX certificate:

```yaml
environment:
  - SIGNING_CERTIFICATE_PATH=/opt/app/backend/data/signing/certificate.p12
  - SIGNING_CERTIFICATE_PASSWORD=change-me
  # - SIGNING_TSA_URL=https://freetsa.org/tsr
```

For production, use an appropriate certificate and timestamp authority for your
legal context. The built-in flow creates PAdES-B-B signatures and upgrades them
to PAdES-B-T when a validated RFC 3161 timestamp service is configured. Legal
qualification depends on the certificate, identity process and trust service
you configure.

## Repository Layout

| Path | Purpose |
|---|---|
| `backend/` | NestJS API, Prisma schema, signing, teams, WebDAV proxy and storage services |
| `frontend/` | Next.js web app |
| `bridge/` | Local PrivCloud Companion source and Native Messaging templates |
| `integrations/` | Browser, mail and desktop integration scaffolds |
| `docs/` | Documentation tooling |
| `scripts/` | Docker and operational helper scripts included in the public build |

## Upgrade Notes

When upgrading an existing instance:

1. Back up the `data/` directory and database.
2. Pull the new image or rebuild locally.
3. Start the container and let Prisma migrations run.
4. Check the logs for compatibility warnings.
5. Verify login, upload, team folders, WebDAV import and signing flows.

The `v1.24.0` migrations preserve existing shares while adding resumable upload
state, explicit completion markers, E2E key-generation preferences and opaque
administrator audit references.

## Documentation

- [CHANGELOG.md](./CHANGELOG.md)
- [integrations/README.md](./integrations/README.md)
- [integrations/PUBLISHING.md](./integrations/PUBLISHING.md)
- [bridge/README.md](./bridge/README.md)

## Credits

PrivCloud Sharing is a fork of
[Pingvin Share](https://github.com/stonith404/pingvin-share). The original
project is licensed under the
[BSD 2-Clause License](https://github.com/stonith404/pingvin-share/blob/main/LICENSE).
