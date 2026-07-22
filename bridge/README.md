# PrivCloud Companion

PrivCloud Companion is the local client-side agent behind PrivCloud browser,
mail and WebDAV integrations. It keeps heavy transfers and encryption on the
user device instead of the SaaS server.

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

```bash
npm run check
npm start
npm run start:native
```

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
