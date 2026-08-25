# PrivCloud Integrations

This folder contains optional client integrations that can be packaged with a
PrivCloud instance.

## Contents

- `browser-extension`: Chromium/Firefox extension with Native Messaging support.
- `thunderbird-extension`: Thunderbird compose helper.
- `outlook-addin`: Microsoft Outlook add-in manifest and task pane.
- `gmail-workspace-addon`: Google Workspace add-on skeleton.
- `desktop`: Native Messaging registration helpers for Windows and macOS.

Source templates use `https://share.example.com` as a placeholder. Never edit
them manually for a release: the build command validates the deployment origin,
injects it into every artifact, aligns extension versions with the root package
and writes SHA-256 checksums:

```bash
npm run build:integrations -- --base-url https://share.your-domain.example
```

The combined command generates both Companion and integration artifacts:

```bash
PRIVCLOUD_BASE_URL=https://share.your-domain.example npm run build:client-tools
```

Artifacts are written to `integrations/dist/`: browser ZIP, Thunderbird XPI,
Outlook ZIP, Google Workspace ZIP and desktop browser-registration helpers.

The companion bridge is shipped from `../bridge` and can be exposed by the
Docker image under `/install/companion`.
