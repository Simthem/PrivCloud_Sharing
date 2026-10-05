# PrivCloud Browser Extension

This extension is the low-friction browser entry point for PrivCloud
Companion.

It provides:

- a content-script bridge for `share.example.com`;
- Native Messaging access to `fr.privcloud.companion`;
- a persistent Native Messaging connection for authorized WebDAV, encrypted
  uploads and job progress;
- bounded download chunks and no HTTP loopback fallback;
- starter buttons for Gmail and Nextcloud pages.

The extension intentionally avoids `<all_urls>`. Cloud-specific content
scripts should be added connector by connector after review.

Desktop WebDAV requires both this extension and the matching Companion native
host. Enable the extension on the configured PrivCloud origin and register its
exact Chrome extension ID (chrome://extensions) with the desktop installer.
Use release 1.25.2 or newer for the native transport protocol.
Restart/reload after updating both components. Older builds cannot use this
protocol. An allowed browser local-network permission is not required.
