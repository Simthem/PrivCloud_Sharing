# Public verification of contractor copies

## October 14 preproduction follow-up

`preproduction-results.json` records a newer private corpus with the exact
source PDF and one exported derived pattern, plus seven laboratory distractors.
In the production Chrome worker, a vertical phone photo matches after local
content-only ORB registration and geometry-derived antialias filtering: score
17.53, runner-up 4.44, threshold 8. Only page 3 of the six-page PDF is accepted.
Two small crops, 631 × 66 and 113 × 135, match at 17.99 and 12.86 through the
automatic fixed-scale supplement. Absent-candidate and wrong-key controls
abstain in all three cases. This is development evidence, not held-out validation
or the actual full team register. Historical cases below remain historical.

The web and native clients offer local PDF reference registration after an
inconclusive photograph. The original must match a recorded source digest.
The reference only supplies geometry. Only capture pixels are resampled.
The registration worker receives no patterns, IDs or keys. OpenCV is fetched
locally on demand, not from a third-party CDN. Cancellation and a three-minute
overall deadline are available. Physical-device performance is not measured.

`fragment-copy-mark.ts` supplements the unchanged v1/v2 decoder only after an
inconclusive result. Its 181 fixed scales use decision threshold 10, compatibility
threshold 8 and minimum gap 2. Multiple plausible IDs still prevent a unique
decision. Bounds: at most 128 candidates, 262144 pixels, sides 32 to 1024.
Larger candidate registers are not truncated. `fragment-results.json` records
three synthetic recoveries, three mixtures without a unique attribution and
zero matches or ambiguities in 100 synthetic negatives. Correlated crops are
not independent trials. Earlier v1 statistical bounds do not transfer.

Explicit diagnostic pattern export now requires a fresh scoped team-admin
passkey. Derivation remains client-side. The unencrypted exported pattern can
reproduce a mark and must remain private. Holding the team audit key already
permits derivation outside this UI. The platform vault remains separate.

```sh
node fragment-benchmark.mjs
node --test test/fragment.test.mjs
```

OCR and unmarked source recreation remain measured signal-erasure failures.
Content similarity never substitutes for copy-specific evidence.

This directory runs without PrivCloud, a database, an account or a production
secret. It contains the watermark algorithm and evidence verifier used by the
application, a format specification and destructive tests with synthetic inputs.
It does not provide the private application's contractor service.

New copies add a whole-page coarse carrier, `privcloud:forensic-multiscale:v2`,
as well as an authenticated visible code. The coarse channel is inspected only
for copies declaring this version in their signed issuance manifest. Legacy,
coarse and visible candidates are combined conservatively, including all pages.
Competing compatible IDs prevent a unique attribution. The visible-code verdict
is separate because a genuine code can be transplanted onto unrelated pixels.

`multiscale-results.json` reports one real development screen photo without a
visible code, recognized directly at score 12.01 against a runner-up of 4.15.
Absent-copy and wrong-team controls abstain. This does not repair older copies.
The current decoder does not change v2 embedding or pattern derivation.
It evaluates fixed, bounded observed-pixel scales, including enlarged captures,
and preserves small images instead of averaging their carrier away. Neutral
padding avoids frequency-estimation gaps. Content skew is checked at two
downsampled resolutions so screen moire is less likely to drive deskew. No
candidate ID or key enters this geometric preparation. Threshold 8 is unchanged.

The refreshed `multiscale-results.json` contains 54 synthetic cases with eight
candidates: all 24 expected detections pass, including central crop/JPEG Q20,
widths 1000, 800, 640, 480 and 320, and zoom 3.4 with central framing. All six
two-copy averages/mosaics report multiple-source ambiguity without a winner.
Three hundred separately seeded negatives at three sizes produce no match.
These development controls are not independent production calibration and do
not inherit the earlier v1 false-match bound.

A real development photograph without a visible code is recognized at all nine
tested widths from 3072 down to 320. Removing its candidate or changing the team
key abstains at every size. This is one photograph reused at several sizes,
not nine independent camera captures. No original-reference registration is used.

A separately reported newly issued preproduction photo remains operator-reported
inconclusive. Its manifest declares v2. Content-only geometry shows local zoom
about 3.2 to 3.5, outside the old detector's 2.5 upper scale. The new synthetic
zoom tests cover this range, but this exact photo's attribution is not locally
verified without its copy's derived pattern. Synthetic success is not substituted
for that missing end-to-end check. Private pixels, filenames, EXIF and image
hashes are not published.
The added pattern can be faintly visible.

`visible-mark-results.json` separately records one real development photo whose
code is recovered directly. Neither photo is a held-out or representative corpus.
Private captures, local filenames, image hashes and EXIF are not published.
OCR and source reconstruction can erase all pixel carriers. Their failures are
not converted into successes or attributed using document content alone.

Use Node 24.15 or later, Python 3.8 or later, OpenSSL and Chrome/Chromium:

```sh
cd verification/contractor
npm ci
npm test
npm run benchmark -- results.local.json
```

For the downloaded ZIP, run these commands inside its extracted directory.

The full suite includes CPU-heavy image searches. The npm entry point runs test
files sequentially, like CI, rather than making these measurements compete.
Allow roughly 10 to 20 minutes on a development workstation, sometimes longer.
The destructive screenshot matrix has a ten-minute deadline and the 54-case,
300-negative multiscale matrix has a thirty-minute deadline. Neither matrix is
reduced or skipped. Long measurements print elapsed-time notices every thirty
seconds when the event loop can run. A notice is not proof of completed work or
a successful result. Synchronous image searches can delay it. The final test
summary and exit status remain authoritative.

Set `CHROME_PATH` when Chrome is not `/usr/bin/google-chrome`. Tests fail if a
required tool is absent. They do not silently substitute a PNG round trip for a
screenshot. Screenshots load a local data document in Chrome without a network
server. API fixtures use HTTPS on loopback with an ephemeral certificate trusted
only by the CLI child process. Certificate and hostname checks remain enabled.
Signature and timestamp tests
run offline. npm needs network access only to install the pinned image library.

`npm test` creates an actual ES256 signature and RFC 3161 timestamp responses using
an ephemeral local test CA, verifies them with the production verifier, and
rejects altered originals, manifests, signatures, events, timestamps, rewritten
chains and truncated journals. The test CA is explicitly trusted by the test
only. It is not an independent time authority, a production authority, or evidence
of a qualified timestamp. No private signing key is stored in this directory.

`npm test` also reruns the destructive watermark benchmark. `results.json` is the
measured reference run. `RESULTS.md` explains its matrix. Each result identifies
the exact algorithm by SHA-256, its decoded pixel hash, dimensions, score, tool
versions and detection time. `WATERMARK_REPORT=/tmp/results.json npm test` saves
the newly measured matrix. Times depend on the machine and concurrent load.

A successful test checks specific examples. It does not prove resistance to all
images or attacks. Three fixtures and eight candidate copies do not calibrate a
real-world false attribution rate. The Gaussian estimate inside the detector is
not such a calibration. Rotation compensation is measured on synthetic pages.
Deliberate erasure still has documented failures.

## Download an archive from a team

Active administrators download certificates and evidence ZIPs after a fresh
passkey confirmation for that copy and download kind. Each administrator uses
their own passkey. The platform retention vault has its separate passkey policy.
Personal access-end reminders are optional and never contain an evidence
attachment or a direct download bearer. The public toolkit ZIP below remains
freely downloadable and offline verification needs no PrivCloud account.

## Verify a real evidence archive

Obtain the TSA root, expected WebAuthn origin/RP ID and a checkpoint from sources
you trust independently. Do not publish a team's audit key, real evidence or
contractor personal data. Retain the checkpoint outside the application **before**
a compromise. Then, with a later evidence ZIP and the original file:

```sh
python3 -I verifier.py evidence.zip \
  --strict --ca trusted-root.pem \
  --expected-origin https://your-application.example \
  --rp-id your-application.example \
  --original original.pdf --checkpoint independently-retained-checkpoint.json
```

Exit codes: 0 means the requested checks passed, 1 means invalid evidence, 2 means
unreadable or malformed input, 3 means strict verification is indeterminate
because required independent evidence is missing. An explicitly supplied but
incorrect TSA root is invalid, not merely indeterminate. Without `--strict`, missing timestamps and unknown TSA roots
remain explicit warnings and can still produce exit code 0. That mode is not a
complete anti-compromise verification.

The verifier treats the archive as hostile input. It rejects ambiguous JSON/CBOR,
unsupported key algorithms and duplicate ZIP entries, bounds evidence and
cryptographic input sizes, applies a timeout to OpenSSL, and removes terminal
control characters from displayed fields. Strict mode requires every independent
input shown in the command above.

Add `--json` for a `privcloud-verification-report-v1` report with explicit
`VALID`, `INVALID` or `INDETERMINATE` status and per-check results. Legal identity,
qualified TSA status and historical revocation are not established by this tool.
New exports retain the RFC 3161 request alongside the response so nonce, imprint
and policy can be compared. Legacy exports without the request explicitly report
that the request nonce was not checked.

`node corpus.mjs corpus.local.json 1000` runs a separately seeded synthetic
negative corpus without changing the threshold. `node benchmark.mjs
extended.local.json --extended` adds rotations, codecs, small crops, image filters
and two-copy mixtures. Neither command substitutes for real camera, print-scan,
independent calibration or collusion studies. See `corpus-results.json` for the
measured corpus, including its statistical assumptions and limitations.

For private real-background controls, run `node real-corpus.mjs INPUT_DIRECTORY
PRIVATE_REPORT.json`. Existing marks are not recovered: the runner overlays a
new known pattern and measures it against the supplied image background. Keep
the report outside the public assets. Input pixels and filenames are not copied
into it. This does not replace end-to-end issued capture or real-photo testing.

The application includes `checkpoint.json` in its evidence ZIP once both the
issuance record and a journal head have timestamp tokens. It does not invent a
checkpoint when the TSA is unavailable. The hourly sealing job runs at minute 55.
Events after the latest successfully timestamped head are not yet anchored.
Downloading a new checkpoint after a compromise cannot establish the earlier
state. The timestamp proves that an imprint existed by its certified time. It
does not certify the precise occurrence time declared in each event.

## Watermark decisions and local tooling

### Multiple plausible patterns

Watermark threshold 8 and minimum score gap 2 are unchanged. Whenever several
tested copy IDs cross the threshold, analysis returns `ambiguous_multiple_sources`
(`AMBIGUOUS_MULTIPLE_SOURCES` in the guide), with no unique winner. Plausible
IDs are combined across geometric hypotheses and all PDF images/pages. A high
score or a large gap does not override that rule. A mixture can also erase all
patterns, or leave just one detectable contributor. This is not a guarantee of
detecting every collusion. Neither a match nor ambiguity proves who disclosed
a document. The worker transfers pattern buffers instead of duplicating them.

### Optional offline screen-photo registration

`photo-results.json` records two actual screen photographs. Direct analysis
recognizes neither. Content-only registration with the correct unmarked page
recognizes both laboratory patterns, with unchanged threshold. These are
development images, not held-out validation or calibrated forensic probabilities.

Use an isolated local environment for the optional image dependencies:

```sh
python3 -m venv /private/path/photo-env
/private/path/photo-env/bin/pip install -r requirements-photo.txt
mkdir private-photo-work && cd private-photo-work
/private/path/photo-env/bin/python /private/path/register-photo.py --reference /private/path/unmarked-page.png --photo /private/path/photo.jpg
/private/path/photo-env/bin/python test/photo-registration.py -v
```

The command prints its new directory under the fixed local
`photo-registrations/` directory. Its name is generated from cryptographic
randomness. No command-line value is used as an output path component and
existing jobs are not overwritten. Inputs are bounded regular files,
symlinks are rejected and OpenCV decoding is limited to 16 million pixels.
The helper matches page content with SIFT/RANSAC and optionally refines the
homography with ECC. It does not accept keys, patterns or expected copy IDs.
If the first content geometry fails, a bounded retry uses 8000 SIFT features
and MAGSAC. Successful established geometry is retained. No watermark score
selects the reference, estimator or output.
Only pixels from the photograph are resampled. It never overlays a reference
page or a watermark. Blank/unrelated references and unreliable geometries fail.
Use a matching reference raster with its original dimensions, no marked copy.
Keep page rasters, photographs and results private. Run untrusted-image tools
offline under an unprivileged account with OS resource limits.

Analyse **all** returned PNG hypotheses together, not just the one scoring best.
The private frontend checkout provides a lossless, multi-page PDF wrapper:

```sh
cd /private/path/work-directory
PRIVCLOUD_PHOTO_PYTHON=/private/path/photo-env/bin/python node /private/path/frontend/scripts/register-forensic-photo.mjs /private/path/unmarked-page.png /private/path/photo.jpg
```

The wrapper prints the generated `registered-photo.pdf` path inside a fresh
local directory. It accepts no output path. Then submit that PDF to the team verifier, which combines all embedded images
and pages before deciding. This requires the corresponding issued patterns in
that team's register. Laboratory documents use a separate synthetic register
and cannot be matched by an unrelated production team's key. The wrapper is a
local maintenance tool requiring
the frontend's installed dependencies, not a command in the public ZIP. Nothing
is uploaded by either tool. Reference-assisted preprocessing is not yet an
automatic browser/native feature. Additional geometric searches need their own
representative negative calibration. Two photographs cannot establish a
production success rate, camera robustness or reliable attribution.

### Synthetic CI screenshots

`node screenshot-preflight.mjs` checks Chrome before the matrix. See below for
the restricted synthetic-only container exception.

### Actual preproduction photo and page encoding

A separate photograph of dense text was reported inconclusive by the deployed
team verifier, both raw and after successful content-only registration. It is
recorded separately in `photo-results.json`, with no private pixels, identity,
local filename or source hash. The supplied evidence archive does not contain
the derived invisible patterns, so its attribution could not be replayed locally.
The original file alone cannot derive a team's secret pattern.

New marked contractor pages use lossless PNG within the existing 6 MiB page
budget. Oversized marked PNGs fail rather than silently using a lossy codec.
This prevents the renderer from discarding its own signal, but does not repair
old WebP/JPEG copies or establish recovery after a physical camera capture.

### OCR and recreation from the unmarked source

`ocr-results.json` records six real Chrome screenshot, Tesseract and text
reconstruction round trips: three with v1 alone and three with v1 plus the
current multiscale v2 decoder. The marked screenshots match before OCR. Each run
recovers 330 words, renders new glyphs on a fresh background and yields no
compatible pattern afterwards. This is measured signal erasure, not recovery.

Install Tesseract with English language data, then run `npm run test:ocr`.
The bounded offline runner uses synthetic public text only and prints the path
of a new private report directory. No output path is accepted as an argument.
The default suite validates the published result and reconstruction guards.

Recreation from the unmarked original is a separate control. Its output has no
recipient-specific signal and must not be attributed to a recipient. Identical
unmarked content can be produced for every candidate. Neither a lower threshold
nor source-content similarity can recover information no longer present.
Resistance to deliberate text recreation requires a separate content-marking
design and validation. It is not established by the current pixel watermark.

### Additional authenticated visible copy marker

New copies can supplement the unchanged invisible pattern with a repeated QR
band outside the original document pixels. The payload is
`PC1:<32-hex-copy-id>:<32-hex-HMAC-tag>`. The tag is the first 16 bytes of
HMAC-SHA256(team audit key, UTF-8 `privcloud:visible-copy:v1:<copy-id>`).
The domain is distinct from invisible-pattern derivation. There is no identity,
document text, team identifier or key in the code. The signed issuance manifest
binds `copy.visibleMarkAlgorithm = "privcloud:visible-copy:v1"` for new copies.

The encoder uses error correction H, three pixels per module and a quiet zone.
The decoder never follows the payload as a URL. It compares complete tokens
against independently derived tokens for the team's known copies, inside the
analysis worker. Two fixed preparations are inspected: bilinear reduction to
1600 pixels, and reduction to 2000 pixels followed by a binomial filter. Each
inspects one whole-image view and at most 81 overlapping 400-pixel tiles.
Tiled search avoids
mixing the finder patterns of repeated codes on a full page.
Cross-page competing visible codes and invisible patterns prevent a unique result.

`visible_marker` is a separate verdict, not an invisible correlation score.
A valid code can be transplanted onto another document. Key holders can also
generate codes. A match does not authenticate surrounding pixels or establish
who disclosed the document. Cropping the band away or recreating pixels through
OCR can erase this second marker too. No retroactive recovery is promised.

`node visible-mark-benchmark.mjs` reruns seven synthetic controls and creates a
new private report directory. `visible-mark-results.json` binds the published
encoder/decoder source and test runner. It measures perspective and JPEG Q20,
wrong-copy/team/tag and unmarked-image controls. A separate physical development
photo is recognized directly, but is not reproduced by the public runner.
No general OCR or reconstruction resistance
is claimed. The public sources reproduce marker encoding/decoding and decisions.

### Chrome sandbox policy

`node screenshot-preflight.mjs` checks Chrome before the matrix. Pipe reset,
broken-pipe and browser-exit errors now fail promptly with bounded diagnostics.
The sandbox stays enabled by default. Some Docker CI runners deny its namespace
creation. Only an explicitly opted-in synthetic fixture, with `CI=true`, a
container marker and `PRIVCLOUD_SYNTHETIC_CHROME_NO_SANDBOX=1`, may run without
it. The GitLab public-proof job sets that exception for its own generated PNG
only. Never use this exception for supplied photos, documents or web content.
It is not a global Chrome setting or a TLS exception.

## Scope of the claims

- Read-only access exposes encrypted rendered page copies to an authorized,
  unexpired contractor seat. It does not grant the original file, original
  decryption key or team membership. Enforcement belongs to server authorization
  tests in the private application. An offline verifier cannot prove deployment
  of those access checks. A displayed page can still be captured or photographed.
- SHA-256 comparison detects a changed original relative to the signed manifest.
  It does not decide whether the original was truthful or malicious when issued.
- A signature binds the manifest to a key. UP/UV are authenticator-reported flags.
  This archive alone does not prove hardware key storage, a physical person's
  identity, legal qualification or a non-exportable credential.
- A recognized watermark identifies an issued pattern. It does not prove who
  leaked the document. An absent watermark does not prove that a document never
  came from that copy. Team key holders can generate patterns themselves.
- Trusted timestamps and an independently retained checkpoint detect changes to
  the issuance record or the retained journal head, including a later rehash or
  truncation. A checkpoint kept only in a compromised database has no independent
  retention guarantee. A rewrite of an unanchored tail remains outside that proof.
- The chain proves continuity of the supplied link range. Other copies are
  represented by opaque content hashes. This privacy-preserving export cannot
  prove completeness of the detailed events attributed to one copy, or events
  that the server never recorded. `chainValidAtGeneration` is an informational
  server assertion, not evidence accepted instead of recomputing the hashes.

See [FORMAT.md](FORMAT.md) for exact fields and hashing rules. The source snapshots
are byte-checked against the application by its regression tests. The public
page is served at `/verification/contractor/index.html` in both private frontend
checkouts, including the native static export. Rebuild the static assets with
`node scripts/build-public-verification.mjs` before building either frontend.
No GitHub synchronization is needed to serve these tools.

## Independently test deployed read-only access

`node read-only.mjs /private/path/test-tenant.json` runs actual HTTPS requests against
an existing test tenant, including an owner positive control on the original.
It verifies the contractor's rendered page ciphertext against a pinned hash,
refuses original bytes, direct-download URLs, original key grants, team keys and
team access, and checks revoked, expired and another seat's copies. It rejects
HTML/WAF responses and redirects. It does not create accounts or send invitations.
Opening preview pages can append ordinary consultation events to the tested tenant.

The private JSON configuration needs `origin` (HTTPS), `teamId`, `shareId`, `fileId`,
`previewId`, `revokedPreviewId`, `expiredPreviewId`, `otherPreviewId`,
`pageCipherSha256` (from the approved page manifest), and `ownerHeaders` /
`contractorHeaders` containing the respective `Cookie` or `Authorization` headers.
Use distinct dedicated test sessions and prepared, known-existing resources.
Keep this configuration outside the repository and protect it with `chmod 600` on
Unix-like systems. The CLI rejects links, non-regular files, oversized files and
permissions accessible to other local users. The report contains only check
names, HTTP status and pass/fail. It excludes sessions, resource IDs and bodies.

The public unit tests verify this HTTPS runner against a loopback fixture, including
an intentionally open original route, altered ciphertext and WAF HTML. They also
reject cleartext origins, redirects, untrusted certificates and wrong hostnames. A fixture
passing is **not** a successful audit of the production deployment. No live SaaS
credentials are included and no production result is claimed here.
