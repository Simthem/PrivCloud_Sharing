# PrivCloud Browser Extension

This extension is the low-friction browser entry point for PrivCloud
Companion.

It provides:

- a content-script bridge for `share.example.com`;
- Native Messaging access to `fr.privcloud.companion`;
- a loopback health fallback for development;
- starter buttons for Gmail and Nextcloud pages.

The extension intentionally avoids `<all_urls>`. Cloud-specific content
scripts should be added connector by connector after review.
