# PrivCloud Companion

PrivCloud Companion is the local client-side agent behind PrivCloud browser,
mail and WebDAV integrations. It keeps heavy transfers and encryption on the
user device instead of the application server.

It exposes two controlled interfaces:

- loopback HTTP on `127.0.0.1:47631` for legacy clients and diagnostics;
- persistent Native Messaging host `fr.privcloud.companion` for desktop WebDAV
  through the browser extension.

The web app never gives its cookies to Companion. The flow is:

1. The user enables the local Companion from an allowed PrivCloud web origin.
   Companion returns a local bearer token to that browser profile. The older
   short-code pairing endpoint remains available as a fallback for diagnostics
   and custom clients.
2. The browser creates a normal PrivCloud share and receives a short-lived,
   share-scoped Bridge upload token from the API.
3. The browser or extension sends the WebDAV app password, selected files,
   upload token and E2EE key to the local Companion.
4. Companion reads WebDAV on the local machine and encrypts E2E chunks with
   the same AES-256-GCM format as the web uploader. When direct S3 upload is
   enabled, the API initializes the object, authorizes bounded parts and checks
   completion. Companion sends those parts straight to S3, without web cookies,
   WebDAV credentials or the encryption key. Unsupported APIs and local or
   relay-only storage keep `/api/shares/:id/files/bridge`. Empty files and
   configured chunks below S3's 5 MiB multipart minimum keep that route too.
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

To build somewhere other than `bridge/dist/` (useful in CI, where wiping a
directory in the work tree is undesirable), call the script directly. The
output directory is wiped first, so it must sit inside the work tree or the
system temporary directory:

```bash
node ./scripts/build-release.mjs --output-dir "$(mktemp -d)/companion"
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
installed trust root. Desktop WebDAV uses Native Messaging instead.

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


## Desktop WebDAV through the extension

The web page sends health, authorization, listing, bounded download chunks,
encrypted upload jobs, progress and cancellation through the browser extension.
The extension uses `connectNative`, validates Chromium's sender origin and keeps
one persistent native port per configured PrivCloud origin. It never trusts an
origin supplied by the page and never falls back to HTTP loopback fetches.
The native host enforces exact origins, expiring sessions and session ownership
of jobs/download readers. Native credentials and sessions remain in memory.
Only the legacy HTTP interface persists hashed pairing tokens. Downloads use
192 KiB blocks to stay below Chromium's 1 MiB native response limit. Input,
concurrency and idle readers are bounded. Disconnect aborts active work.

Install/update **both** Companion and the browser extension. Enable the extension
on the configured PrivCloud instance. For Chrome/Chromium, find its exact ID in
`chrome://extensions`, then register the native host on Linux:

```sh
PRIVCLOUD_COMPANION_PATH="$HOME/.local/bin/privcloud-companion" \
PRIVCLOUD_CHROME_EXTENSION_ID='YOUR_32_LETTER_EXTENSION_ID' \
sh "$HOME/.local/share/privcloud-companion/register-native-messaging.sh"
```

Replace the ID placeholder with the actual ID (letters a-p). Keep the path of
your installed launcher. Packages installed under /opt provide the registration
script in /usr/share/privcloud-companion. Windows/macOS registration helpers
are provided under integrations/desktop. Reload PrivCloud after updating.
The frontend reports a missing extension, outdated transport, expired session
or unavailable native host without probing localhost. Local-network permission
does not control Native Messaging. Android browsers keep a permission-guarded
HTTP loopback route for a compatible connector running on the device. This
compatibility route is never selected on desktop.

Run `npm run test:companion-browser` in frontend. This starts the actual extension
and Companion in a temporary Chrome profile, with an isolated HTTPS WebDAV/API
fixture. Local-network permission is tested both denied and granted. It checks
health/authorization, a download larger than 1 MiB, byte integrity,
end-to-end encrypted upload, persistent job polling and cancellation. Network
and Audits are both enabled.
**Any** console error, failed browser request or DevTools audit fails the test.
No browser issue is filtered or hidden. `test:companion-browser:real` is an alias
for the same full native check. CHROME_BIN can select a compatible Chromium
build supporting Extensions.loadUnpacked with remote debugging pipes.

[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
explains persistent ports, sender validation and message size limits.


## Linux packages, NVM and Chromium Flatpak

`dpkg` checks the system `nodejs` package, independently of NVM. Node 20+ is
still mandatory at runtime. Package and portable launchers can explicitly pin
an NVM executable. They never source a shell configuration or install Node as
root. In the NVM shell, run **without sudo**:

```sh
/usr/bin/privcloud-companion --configure-runtime "$(command -v node)"
```

For portable archives use `./privcloud-companion --configure-runtime` with the
same absolute Node path. The setting is written atomically with mode 0600 to
`~/.config/privcloud-companion/node-path`. Reconfigure before removing that NVM
version. A missing or obsolete runtime fails with instructions on stderr.
Native Messaging stdout stays reserved for framed responses.

Linux package builders can ship the reusable launcher in `install/linux/`.
The public source archive includes the user installer and registration helper.
When using a system package that installs the helper under `/usr/share`, register
the native host **without sudo**:

```sh
PRIVCLOUD_CHROME_EXTENSION_ID='YOUR_32_LETTER_EXTENSION_ID' \
sh /usr/share/privcloud-companion/register-native-messaging.sh
```

The curl installer already pins Node and calls registration. The helper also
registers installed Chromium Flatpak profiles under
`~/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts`.
The exact extension ID must come from that browser. The helper does not add
Flatpak overrides or `flatpak-spawn --host` access. For package installations,
it copies the dependency-free native payload into a user directory visible to
the existing sandbox. The configured Node executable must also be visible there.
Chromium Flatpak 154.0.8037.57 with NVM Node 24 was tested end to end.
Other sandboxed browsers and custom profiles need their own verified registration.

To test the installed Chromium Flatpak in an isolated temporary profile:

```sh
cd frontend
CHROME_FLATPAK=org.chromium.Chromium npm run test:companion-browser
```

This uses the shipped curl installer and registration script, then verifies
health, authorization, listing, a 2 MiB download and encrypted upload/cancellation
with zero page loopback requests, console errors or DevTools audits.

## Transfer Performance And Encrypted Names

Direct uploads use `/api/shares/:id/files/bridge/multipart/init`, `part-urls`
and `complete`. Every call checks the existing share-scoped upload token.
The same storage quotas, completed-share checks and signed payload lengths apply.
S3 PUTs carry only the authorized file bytes and their Content-Length.
Authorization URLs are refreshed for retries and redirects are refused.
After a direct upload starts, a permanent storage error fails the job rather
than restarting it through the relay and counting its bytes twice.

Each managed job processes up to two files concurrently. Across all jobs and tabs,
at most two files open WebDAV streams and at most four S3 PUTs run at once.
Each file also respects the API upload-concurrency limit and a 128 MiB working
buffer budget. Queued files do not open WebDAV streams, and cancellation removes
their waiters. A failed file aborts and drains its siblings before the job ends.
Chunks normally stay at or below 8 MiB and can grow to 32 MiB to stay within
S3's 10,000-part limit for large transfers.
The concurrency decreases for larger chunks. Files are read incrementally,
never materialized as one whole buffer. Progress counts accepted plaintext
bytes once, including when a PUT has to be retried.

The browser requires the `fileMetadataV1` capability before handing a protected
share to Companion. Older connectors fail before receiving the job.
When the share uses FILE_META_V1, Companion also encrypts its file names with
the content key and the browser's share/file authenticated context. Both the
direct and relay routes receive the neutral file name and encrypted metadata.
Without this scheme, names retain the existing readable behavior.

Native Messaging downloads combine small WebDAV packets into frames of at
most 192 KiB. The final partial frame is retained and readers are cancelled
when the port closes. This reduces browser/extension round trips while keeping
the existing frame and memory bounds.

The legacy HTTP listener is restricted to literal loopback addresses and
loopback peers. Exact origin checks and bearer tokens remain required. Desktop
web imports use Native Messaging. A Snyk HTTP-to-HTTPS warning still identifies
the legacy diagnostic listener, which is not changed to untrusted self-signed
TLS and is not suppressed by a new scanner exclusion.
