# Measured watermark and decision tests

## October 14 follow-up

The historical matrices below retain their original scope and bytes.
`preproduction-results.json` adds three previously inconclusive private cases
verified with the production Chrome worker: a vertical photo registered against
the exact source PDF at 17.53 and two crops at 17.99 and 12.86. All three
absent-candidate and wrong-team controls abstain. One real exported pattern plus
seven synthetic distractors is not a full production register or a held-out
photo corpus. The landscape photo is rejected by strict reference registration.

`fragment-results.json` adds a separate fixed-scale bench with threshold 10
for unique decisions and 8 for any compatible competitor: three positive
synthetic crops, three mixtures without a unique winner and 100 synthetic
negatives with zero matches or ambiguities. No production probability follows.
See the README for bounds, local PDF workflow and the sensitive passkey-gated
pattern diagnostic. Historical OCR/source-erasure failures are unchanged.

All five synthetic reports were regenerated on 2026-10-13 against algorithm SHA-256 `fb0ba29f59b48c25f30692f69345aaa8f908619a641e597edcac693fe4e8bee6`. Embedding v1, threshold 8 and minimum score gap 2 are unchanged. Scores describe compatibility, not the identity of a person or a calibrated attribution probability.

## Baseline and transformations

The five v1 reports below do not measure the newly added coarse carrier or the
combined legacy/coarse/visible decision. Their calibration does not transfer to
these extra search channels.

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

The web production worker also checks the development photo through actual
browser image decoding and canvas resampling. Original, 2000-pixel and 320-pixel
inputs recover the copy, with absent-copy/wrong-team abstention at each size.
The browser's 320-pixel score is 8.88, against 16.14 with the separately tested
Sharp resampling. The margin depends on interpolation. Original-image analysis
takes about 34 seconds in this desktop run, versus about 11 seconds at 320.
These are complete-worker times, not the coarse-channel-only timings. They are
not mobile performance guarantees. See the report for per-case values.

The visible code is recognized on a separate development photo.

`results.json` measures 42 cases using three synthetic 1920 x 1440 pages and eight candidates. Real Chrome screenshots, 20/50% area crops, JPEG Q90/Q60, resize to 800 pixels, rotation 2 degrees and contrast pass 3/3. Background whitening passes 2/3. Source-pixel recreation erases the signal, 0/3. Six unmarked/wrong-key controls yield no matches. Actual photographs and OCR are measured separately in `photo-results.json` and `ocr-results.json`, not in these 42 synthetic cases.

`extended-results.json` contains 186 cases. Rotations from -5 to +10 degrees, 45, 90 and 180 degrees, combined rotation/crop/resize, AVIF Q20 and central crops removing 90% of area pass 3/3. Fine angles -0.75, -0.5, -0.25, -0.1, +0.1, +0.25, +0.5 and +0.75 degrees pass 3/3. White-page scores at -0.5/+0.5 are approximately 36.0/36.1 because weak direct matches now also undergo deskew.

Blur sigma 0.5 now changes the pixel hash on every fixture. Its explicit float kernel and lower minimum amplitude prevent the previous identity operation. It passes 3/3. JPEG Q10 still passes only 1/3. Resize to width 480/320, inversion and tested binarizations remain 0/3.

All six average/mosaic two-copy cases report `ambiguous_multiple_sources`, both contributing IDs plausible and no unique winner. The old single-target detection metric is not a success criterion for mixtures. A mixture can erase patterns or preserve only one contributor. This is not general collusion resistance.

## Negative and candidate-count controls

`corpus-results.json` measures 0 matches in 1,000 separately seeded synthetic 320 x 256 trials with eight candidates. Under independent Bernoulli assumptions, the one-sided 95% zero-failure upper bound is approximately 0.299%. This is not a production or photo-preprocessing bound.

`candidate-scale-results.json` passes 8/8 positive/negative controls at 100 and 1,000 candidates. Patterns alone occupy 65,536,000 bytes at 1,000 candidates, before images, FFT and worker overhead. Local timings are not a mobile performance guarantee.

`decision-evaluation-results.json` adds 99 separately seeded controls at 8, 100 and 1,000 candidates. In each group, 30 negative trials yield zero matches and zero plausible signals. The per-group one-sided 95% bound is approximately 9.50%, not 0.299%. There are three isolated positives, three mosaics and three averages. Expected recovery decisions pass 96/99. The three averages are inconclusive rather than detected as multiple-source mixtures. All 99 safety checks pass because none names an uninvolved or uniquely selected mixture source. Abstention is not successful recovery. Reported RSS is a post-case process observation, not peak memory. These small synthetic groups do not calibrate production attribution.

## Two actual screen photographs

`photo-results.json` publishes aggregate measurements only. The private photographs are not distributed. Two 3072 x 4080 photographs of one displayed laboratory page are inconclusive without preprocessing, scores approximately 4.88 and 5.16.

Using the correct unmarked raster as a content reference, SIFT/RANSAC and optional ECC produce at most two geometric hypotheses. Combining them recognizes the correct laboratory copy in both photographs: approximately 11.11 front and 17.67 angled, above the unchanged threshold 8. No watermark key or expected ID enters registration. Only photograph pixels are resampled. Excluding the expected copy yields no attribution. A synthetic projected unmarked page has no match, a projected copy B is recognized as B, and an unrelated reference is rejected.

These two photographs were used during development. They are not held-out evidence or a representative statistical corpus. The browser/native detector still cannot directly recognize these raw photos. Offline preprocessing with the reference is required. See the README for the bounded optional helper and multi-page PDF workflow. Blind perspective recovery, printed-document photographs, other cameras, capture conditions, physical-device performance and production attribution remain unvalidated. The extra geometric hypotheses require independent negative calibration.

## Reproduction and trust

### Additional preproduction photo

The separate dense-text screen photograph remains inconclusive in the operator's
deployed team verifier, raw and after registration. Registration now succeeds
with 822 content inliers using a bounded MAGSAC fallback. Geometric success is
not watermark recovery. The evidence archive has no derived production patterns,
so no local attribution score is claimed. This failure is not counted among the
two laboratory successes. New marked pages use lossless PNG to avoid lossy
encoding before delivery. Existing copies and camera robustness are not repaired
or validated by that change.

### Actual OCR round trips

`ocr-results.json` measures six real Chrome/Tesseract 5.3.4 round trips:
three with v1 alone and three with v1 plus multiscale v2. All marked captures
are recognized before OCR, with scores about 33. Each yields 330 words.
Newly rendered text has zero compatible patterns in all six cases, with scores
about 4.60 to 4.92. Recovery is 0/3 for each carrier configuration and 0/6 overall.
Safe abstention is 6/6. Source recreation also abstains in all six cases.
This does not establish results for every OCR engine or document.

### Additional visible copy marker

`visible-mark-results.json` passes seven synthetic controls for the additional
authenticated QR band. Intact, perspective and perspective/JPEG Q20 cases recover
the expected marker. Wrong-copy, wrong-team, invented-tag and unmarked controls
recover none. These are synthetic images, not physical smartphone photographs.
The original invisible v1 algorithm and its measurement matrices are unchanged.
The separate coarse carrier and visible code are additional search channels.
Visible-only recovery has a distinct verdict. A transplanted authentic code
does not authenticate its surroundings. Full OCR recreation or cropping all
codes away can still erase this marker. Existing production copies lack it.

### Journal compatibility

An early private export exposed a real compatibility defect: flat historical
hashes were checked as split content/link hashes. The exact legacy formula is
now verified before a one-way transition to the split format. Stored events and
anchors remain unchanged. Modified content, anchor mismatches and format
downgrades remain rejected. Opaque historical links remain indeterminate in
strict offline verification when other-copy content is unavailable.

Run `npm test` for destructive measurements and evidence tampering checks. Use `node benchmark.mjs extended.local.json --extended`, `node corpus.mjs corpus.local.json 1000`, `node candidate-scale.mjs candidates.local.json` and `node decision-evaluation.mjs decisions.local.json` for separate reports. The optional photo regression suite is described in the README. Every public report is source-bound. The compact article summary is generated from the measured synthetic reports, without embedding full matrices.

Detection absence does not exclude an origin. A match does not prove who leaked a document. Team key holders can generate patterns. Do not publish team keys, private photographs or evidence. Independent evidence checks require separately selected trust anchors and a checkpoint retained before compromise. Local HTTPS authorization fixtures do not establish deployment correctness. Real preproduction checks, historical trust/revocation and independent audit are still required.
