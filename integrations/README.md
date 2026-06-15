# PrivCloud Integrations

This folder contains optional client integrations that can be packaged with a
PrivCloud instance.

## Contents

- `browser-extension`: Chromium/Firefox extension with Native Messaging support.
- `thunderbird-extension`: Thunderbird compose helper.
- `outlook-addin`: Microsoft Outlook add-in manifest and task pane.
- `gmail-workspace-addon`: Google Workspace add-on skeleton.
- `desktop`: Native Messaging registration helpers for Windows and macOS.

All examples use `https://share.example.com` as a placeholder. Replace it with
your public PrivCloud URL before packaging or publishing an integration.

The companion bridge is shipped from `../bridge` and can be exposed by the
Docker image under `/install/companion`.
