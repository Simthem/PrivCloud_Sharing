# PrivCloud Companion

PrivCloud Companion is the local client-side agent behind PrivCloud browser,
mail and WebDAV integrations. It keeps heavy transfers and encryption on the
user device instead of the application server.

It exposes two controlled interfaces:

- loopback HTTP on `127.0.0.1:47631` for the PrivCloud web app;
- Native Messaging host `fr.privcloud.companion` for browser and mail
  extensions.

The web app never gives its cookies to Companion. The flow is:

1. The user enables the local Companion from an allowed PrivCloud web origin.
   Companion returns a local bearer token to that browser profile. The older
   short-code pairing endpoint remains available as a fallback for diagnostics
   and custom clients.
2. The browser creates a normal PrivCloud share and receives a short-lived,
   share-scoped Bridge upload token from the API.
3. The browser or extension sends the WebDAV app password, selected files,
   upload token and E2EE key to the local Companion.
4. Companion streams WebDAV to the local machine, encrypts each chunk with the
   same AES-256-GCM chunk format as the web uploader, then uploads chunks to
   `/api/shares/:id/files/bridge`.
5. The browser polls the local job and completes the share through the normal
   authenticated API once every file is uploaded.

WebDAV credentials are kept in memory for the job and are not written to disk.
The only persisted Companion state is the local pairing token hash in
`~/.privcloud-bridge/state.json`.

## Development

Companion has no dependencies and no transpilation step, so there is nothing to
install first. Node.js 20 or newer is the only requirement. Run these from the
`bridge/` directory:

```bash
npm run check        # syntax-check the runtime (node --check)
npm start            # run the loopback HTTP server on 127.0.0.1:47631
npm run start:native # run as a Native Messaging host on stdio
npm test             # node --test on test/*.test.mjs
```

From the repository root, the same test suite is `npm run test:bridge`.

## Build A Release Artifact

```bash
# from bridge/
npm run build

# or, from the repository root
npm run build:companion
```

`npm run build` is `npm run check` followed by `scripts/build-release.mjs`.
Before writing anything, the script enforces two contracts and aborts on either:

- `const VERSION` in `src/privcloud-bridge.mjs` must equal the `version` field
  of `bridge/package.json`. A release whose runtime reports a version different
  from its package is rejected rather than published.
- the source must still carry the `openSourceLocalAuthorization: true` marker.

It then wipes and recreates `bridge/dist/` with three files:

| File | Contents |
| --- | --- |
| `privcloud-companion-<version>.tgz` | the release archive |
| `manifest.json` | version, byte size and SHA-256 of the archive |
| `SHA256SUMS` | the same digest in `sha256sum -c` format |

The archive holds `package/` with the runtime (`src/`), the Linux installer and
Native Messaging registration helper (`install/`), the browser manifests
(`native-messaging/`), `package.json` and this README. Shell scripts and
`privcloud-bridge.mjs` are stored mode 0755, everything else 0644.

The build is reproducible: entries are sorted, timestamps are pinned to 0 and
gzip runs at a fixed level, so the same source always yields the same SHA-256.
Verify a published archive with:

```bash
cd bridge/dist && sha256sum -c SHA256SUMS
```

To build somewhere other than `bridge/dist/` — useful in CI, where wiping a
directory in the work tree is undesirable — call the script directly:

```bash
node ./scripts/build-release.mjs --output-dir /path/to/output
```

Note that `npm run build` is **not** what puts Companion in front of end users.
The Docker image copies `bridge/src/privcloud-bridge.mjs`, `bridge/install/` and
this README into `public/install/companion/` (see the `Dockerfile`), and the
one-line installer downloads them from a running instance. The `dist/` tarball
is the artifact for signed desktop packaging, described under Release Signing
below.

## Configuration

By default Companion listens on `http://127.0.0.1:47631` and allows local
development origins plus `https://share.example.com`.

The HTTP listener is intentionally restricted to the literal loopback
addresses `127.0.0.1` or `::1`; non-loopback binds and peers are rejected.
Companion additionally requires an exact allowed web origin and bearer
authentication for operational endpoints. A self-signed localhost certificate
is not used because browsers cannot authenticate it without a separately
installed trust root. Native Messaging remains available when a browser-managed
authenticated transport is preferred.

Useful environment variables:

```bash
PRIVCLOUD_BRIDGE_HOST=127.0.0.1
PRIVCLOUD_BRIDGE_PORT=47631
PRIVCLOUD_BRIDGE_ORIGINS=http://localhost:3000,https://share.example.com
PRIVCLOUD_BRIDGE_ALLOW_HTTP_WEBDAV=1
PRIVCLOUD_COMPANION_NATIVE_ORIGINS=https://share.example.com
```

`PRIVCLOUD_BRIDGE_ALLOW_HTTP_WEBDAV=1` is only for local lab servers.

## Release Signing

The source is dependency-free Node.js so it can be packaged as a small signed
desktop helper:

- Linux: `.deb` / `.rpm` / AppImage signed with minisign or Sigstore.
- Windows: `.exe` signed with Authenticode.
- macOS: `.pkg` or `.app` signed and notarized with Apple Developer ID.

Production downloads should publish checksums and detached signatures, and the
web app should link only to the signed release channel.

Native Messaging manifests are available in `native-messaging/`. Linux
registration helpers are in `install/linux/` and are intended to be called by
the signed desktop package post-install step.
