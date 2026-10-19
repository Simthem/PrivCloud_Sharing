# Document and media previews

Previews use authenticated reads and decrypt E2E data in the browser. PDF and
media readers request byte ranges instead of waiting for a complete download.
The bounded read cache lives in memory. The preview service worker handles only
ephemeral media URLs and does not persist plaintext in Cache Storage.

Supported readers include PDF, DOCX, XLSX, XLS/XLT, XLSB, PPTX, ODT, ODS and ODP,
alongside text, source code and browser-compatible images and media. Document
rendering is bounded and may differ from the originating application. Very large
documents, unsupported embedded objects and unsupported codecs can refuse a
preview while the authorized download remains available.

HEIC and TIFF are decoded locally in a dedicated worker. RAW previews use an
embedded JPEG or RGB preview when the format supports one. TIFF/DNG directory and
preview reads use authenticated ranges. Other RAW layouts retain a bounded
fallback and can remain unsupported.

HEVC videos use a local software decoder when browser decoding is unavailable.
Video controls include seeking, volume and fullscreen. Images and PDFs support
zoom from 25% to 400%. Worker-specific policies permit decoder WebAssembly
without permitting dynamic code in the main document. The build serves decoder
libraries with their licenses and replacement notices.

Legacy E2E formats can require a complete cryptographic record before any of its
content is available. They do not provide arbitrary plaintext byte access with
the same cost as newer record-based files. Memory, document and decoded-pixel
limits still apply.

Run `npm run test:frontend` for parser, range, authorization and message-boundary
checks. `npm --prefix frontend run test:preview-browser` and
`npm --prefix frontend run test:video-preview-browser` exercise the actual browser
readers with synthetic HTTPS fixtures. These checks do not establish support on
every physical device or storage deployment.
