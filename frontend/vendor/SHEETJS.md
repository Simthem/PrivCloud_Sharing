# SheetJS Community Edition

`xlsx-0.20.3.tgz` is a local, pinned dependency obtained from the official CDN:
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz

SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`

The tarball includes its Apache-2.0 LICENSE. It is bundled only into the legacy
spreadsheet worker, with no runtime request to an external CDN. The npm registry
release is older and is not used. Installation and security references:

- https://docs.sheetjs.com/docs/getting-started/installation/nodejs/
- https://cdn.sheetjs.com/advisories/CVE-2024-22363
- https://cdn.sheetjs.com/advisories/CVE-2023-30533
- https://docs.sheetjs.com/docs/miscellany/formats/

SheetJS states that CVE-2024-22363 was corrected in 0.20.2 and
CVE-2023-30533 in 0.19.3. The pinned 0.20.3 source therefore contains both
fixes. Direct regressions exercise the repeated XML-comment ReDoS payload and
the threaded-comment prototype-pollution payload.

The library is bundled into a dedicated browser worker. It is absent from the
Next.js standalone server tree. The production image keeps a minimal runtime
manifest and does not ship the complete frontend build lockfile.

See `docs/DOCUMENT_PREVIEWS.md` for input, execution and output bounds.
