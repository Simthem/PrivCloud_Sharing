# PrivCloud Desktop Companion Packaging

This folder contains the Native Messaging registration layer for the signed
Windows and macOS Companion packages.

The actual Companion runtime is `bridge/src/privcloud-bridge.mjs`; production
installers should embed a Node.js runtime or ship a small native launcher so
end users do not have to install Node.js manually.

## Windows

Use `windows/register-native-messaging.ps1` from the MSI/MSIX installer custom
action, or run it manually for a beta package.

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\register-native-messaging.ps1 `
  -CompanionPath "C:\Program Files\PrivCloud Companion\privcloud-companion.cmd" `
  -ChromeExtensionId "REPLACE_CHROME_STORE_ID" `
  -EdgeExtensionId "REPLACE_EDGE_STORE_ID" `
  -Scope LocalMachine
```

`Scope LocalMachine` writes under `HKLM` and requires elevation. `Scope
CurrentUser` writes under `HKCU` and is useful for internal beta installs.

## macOS

Use `macos/install-native-messaging.sh` from the signed `.pkg` postinstall
script, or run it manually for a beta package.

```sh
PRIVCLOUD_COMPANION_PATH="/Applications/PrivCloud Companion.app/Contents/MacOS/privcloud-companion" \
PRIVCLOUD_CHROME_EXTENSION_ID="REPLACE_CHROME_STORE_ID" \
PRIVCLOUD_EDGE_EXTENSION_ID="REPLACE_EDGE_STORE_ID" \
./install-native-messaging.sh --system
```

`--system` writes to `/Library/...` and requires root. Without it, manifests are
installed in the current user's browser profile locations.

## Release Checklist

1. Build beta artifacts with `scripts/release/build-beta-install-artifacts.sh`.
2. Build production installers that embed the Companion runtime.
3. Replace browser extension IDs after each store creates the production item.
4. Run the registration script during install and during app repair/update.
5. Sign Windows packages with timestamping.
6. Sign and notarize macOS packages with Apple Developer ID.
7. Publish SHA-256 checksums and detached signatures alongside downloads.

