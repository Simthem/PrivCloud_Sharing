# Publishing Integrations

Use this checklist before publishing browser, mail, Windows, or macOS
integrations for a public instance.

## Common Setup

1. Replace every `https://share.example.com` value with your public URL.
2. Replace icons, support URLs, privacy URLs, and provider names as needed.
3. Build the main Docker image so `/install/...` serves the packaged files.
4. Test login, upload, E2E upload, and large-file upload from each integration.
5. Keep store submissions tied to your own publisher accounts.

## Browser Extension

- Update `integrations/browser-extension/manifest.json` host permissions.
- Keep the Native Messaging host name aligned with `bridge/native-messaging`.
- Package the folder as a ZIP for Chromium-based stores.
- For Firefox, keep the Gecko extension ID stable across releases.

## Mail Integrations

- Thunderbird: package `integrations/thunderbird-extension` as an XPI.
- Outlook: update `manifest.xml`, host `taskpane.html`, then sideload or submit
  through Microsoft Partner Center.
- Google Workspace: create an Apps Script project from
  `gmail-workspace-addon`, update `appsscript.json`, and deploy from the
  Google Cloud project that owns the add-on.

## Desktop Native Messaging

- Windows: run `integrations/desktop/windows/register-native-messaging.ps1`
  after installing Node.js and the bridge script.
- macOS: run `integrations/desktop/macos/install-native-messaging.sh`.
- Linux helper files live in `bridge/install/linux`.

## Release Hygiene

- Do not publish secrets, private domains, or instance-specific credentials.
- Keep all comments and public text in English for the open-source repository.
- Re-run a text scan for private domains and private image tags before pushing
  a public release.
