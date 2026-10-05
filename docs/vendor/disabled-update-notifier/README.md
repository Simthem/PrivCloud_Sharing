# Disabled documentation update checker

This package removes Docusaurus's optional CLI update checker. Docusaurus
continues to check its supported Node.js version and to build, serve and watch
the documentation. The CLI no longer displays the npm update notification.

The original update checker pulls in `got`, `cacheable-request` and
`http-cache-semantics`. The latter has no patched release for
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
as of October 3, 2026. Setting `NO_UPDATE_NOTIFIER` alone leaves the vulnerable
dependency installed. This replacement has no dependencies and performs no
network, cache, file or subprocess operations.

Docusaurus reads the returned `config` and `update` fields conditionally.
Returning both as undefined preserves that interface and disables only the
update checker. The actual package name is `@privcloud/disabled-update-notifier`,
resolved through a direct local dependency and the `$update-notifier` override.
There is no advisory allowlist or fake upstream version.
