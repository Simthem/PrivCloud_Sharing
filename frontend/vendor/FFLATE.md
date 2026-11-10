# ZIP extraction limits

The frontend pins `fflate` 0.8.3 and applies
`scripts/patch-fflate.cjs` during installation and before development or production builds. CVE-2026-122146 concerns
`unzipSync` and `unzip`: they allocate from archive-declared output sizes.
There is no published upstream fix in the reviewed release.

The local guard checks the complete ZIP directory before either API can
allocate output buffers or start decompression workers. Limits per extraction:

- 64 MiB of compressed input and 64 MiB of declared total output.
- 32 MiB of declared output per entry.
- 1,024 entries, a 2 MiB directory and 1,024 bytes per entry name.
- At most four decompression workers for an asynchronous extraction.

The extraction APIs reject ZIP64, encryption, inconsistent local/central
metadata, duplicate names and object-prototype property names. These bounds
also apply when a caller supplies a filter. Extraction supports ordinary
stored and deflated ZIPs, UTF-8 names, comments and streaming data descriptors.

These limits apply to the two whole-archive extraction APIs. ZIP creation,
`Zip`/`ZipPassThrough` downloads and raw `Inflate` keep their existing behavior.
Office previews use their own range reader and bounded streaming inflater,
with their existing preview budgets. No external conversion service is used.

The patch covers all six upstream JavaScript entry points: Node and browser
CommonJS, both ES modules, the legacy CommonJS entry and UMD. It verifies the
reviewed upstream SHA-256 values, rejects an unreviewed version or modified
source, and can be reapplied without changing an already guarded installation.
Both Docker builders recheck it after copying cached dependencies. The
Webpack cache includes the patch digest.

For an existing installation, from `frontend/`, run:

```sh
node ../scripts/patch-fflate.cjs
node --test test/fflate-security.test.mjs
```

Restart the development process or rebuild before serving updated bundles.
The regression suite intercepts the original oversized allocation without
performing it, checks rejection before allocation in the guarded APIs, and
exercises normal extraction, workers, filters and large streamed ZIP creation.

This is a local mitigation, not an upstream version upgrade. The package
version remains 0.8.3, and a dependency scanner may continue reporting the CVE.
Do not hide that finding or claim a clean scan without new scanner evidence.
Review this patch when an upstream fixed release becomes available.

References: [original disclosure](https://github.com/ictrun/java/issues/9),
[upstream releases](https://github.com/101arrowz/fflate/releases).
