# Contractor evidence and checkpoint format, version 1


## Private derived-pattern diagnostic

The team register can export one explicitly selected copy after confirmation.
This is an unencrypted local diagnostic, not a signed evidence archive. Its
canonical JSON has exactly four fields in this order:

`{format:"privcloud-derived-copy-pattern-v1",markId,robust,pattern}`

`markId` is the copy's 32-character lowercase hexadecimal identifier.
`robust` is true only for declared multiscale v2 copies. `pattern` contains
16384 finite values in [-1,1]. The parser rejects additional or duplicate fields,
noncanonical encodings and inputs above 512 KiB. The export contains no audit key,
sessions, identity or document. It can nevertheless reproduce this copy's pixel
mark, so keep it private and share it only for an explicitly authorized diagnosis.
It cannot certify the identity of its sender or the authenticity of a photograph.
The diagnostic does not contain the separately authenticated visible-code token.
All hashes below are lowercase hexadecimal SHA-256. Encoded strings marked
`base64url` use the URL-safe alphabet without padding. RFC 3161 responses use
standard base64 and contain DER `TimeStampResp`, not just the CMS token.

New issuance manifests may include `copy.robustMarkAlgorithm` with the sole value
`privcloud:forensic-multiscale:v2` and `copy.visibleMarkAlgorithm` with the sole
value `privcloud:visible-copy:v1`. Both optional fields participate in the
canonical manifest hash and passkey challenge. Missing fields preserve the old
protocol. The register exposes the coarse version from this manifest so older
copies are not searched using a carrier they never received. `copy.markAlgorithm`
still identifies the original v1 carrier, which remains present.

## Deterministic JSON

`C(value)` recursively emits compact JSON, sorting object keys with the
application's `localeCompare` order. The schema has fixed ASCII keys. Arrays
retain their order. Strings retain their exact Unicode characters and escaping
as emitted by `JSON.stringify`. The Python verifier implements the same key order
for this schema. Integers are JSON integers, timestamps are ISO UTC strings
with millisecond precision. This format is **not RFC 8785 JCS**. The manifest is
stored as its exact serialized string. verify its byte hash before reserializing.
`H(value)` below is SHA-256 over the UTF-8 bytes of `C(value)`.

## Evidence object

`format = "privcloud-contractor-issuance-evidence-v1"`. `generatedAt` and
`howToVerify` are informational and are not signed. `issuance` contains:

| Field | Meaning |
| --- | --- |
| `id` | Issuance identifier |
| `manifest` | Exact deterministic JSON string described below |
| `manifestHash` | SHA-256 of UTF-8 `manifest` bytes |
| `webauthn.credentialId` | base64url credential identifier |
| `webauthn.publicKeyCoseBase64Url` | base64url CBOR COSE public key |
| `webauthn.algorithm` | ES256 `-7` or RS256 `-257` supported by the verifier |
| `webauthn.authenticatorDataBase64Url` | base64url raw authenticatorData |
| `webauthn.clientDataJSONBase64Url` | base64url raw clientDataJSON |
| `webauthn.signatureBase64Url` | base64url raw WebAuthn signature |
| `webauthn.userHandleBase64Url` | Optional user handle, informational |
| `recordHash` | Hash of the record below |
| `rfc3161TimeStampRespBase64` | Timestamp over raw `recordHash` bytes, or null |

The manifest has `protocol = "privcloud-contractor-issuance-v1"`, `nonce`,
`issuedAt`, `team: {id,name}`, `issuer: {userId,email}`,
`contractor: {seatId,email,name}` (`name` may be null), `accessExpiresAt`, and:

```json
{
  "copy": {
    "previewId": "copy-id",
    "sourceFileId": "source-id",
    "sourceSha256": "64 lowercase hex characters",
    "markId": "32 lowercase hex characters",
    "pageCount": 1,
    "pages": [{
      "plainSha256": "64 lowercase hex characters",
      "cipherSha256": "64 lowercase hex characters",
      "width": 1920,
      "height": 1440
    }]
  }
}
```

The signed WebAuthn challenge equals `base64url(bytes(manifestHash))`.
`clientDataJSON.type` must equal `webauthn.get`. Verify the signature over
`authenticatorData || SHA256(rawClientDataJSON)`, UP/UV flags and the expected RP ID
hash. The default verifier uses the origin hostname as RP ID. Supply `--rp-id`
for a parent-domain RP ID or native origin, and `--expected-origin` to pin the
expected origin independently of the archive. A COSE key supplied by the archive
alone is not an independent identity certificate.

`recordHash` is `H` of this object, whose values are copied exactly:

```text
{
 protocol: "privcloud-contractor-issuance-v1",
 manifest: issuance.manifest,
 credentialId: issuance.webauthn.credentialId,
 credentialPublicKey: issuance.webauthn.publicKeyCoseBase64Url,
 credentialAlgorithm: issuance.webauthn.algorithm,
 authenticatorData: issuance.webauthn.authenticatorDataBase64Url,
 clientDataJSON: issuance.webauthn.clientDataJSONBase64Url,
 signature: issuance.webauthn.signatureBase64Url
}
```

## Journal

`journal.protocol = "privcloud-contractor-journal-v1"`. `journal.teamId` matches
the manifest's team. Each event has `seq`, `at`, `kind`, `previewId`, `seatId`,
`actorEmail`, `pageIndex`, `prevHash` and `hash`. Kinds currently used are `ISSUED`,
`OPENED`, `PAGE`, `DELETED`, `REVOKED` and `VAULT`. The last four content fields
may be null where the event allows it.

```text
contentHash = H({protocol,teamId,at,kind,previewId,seatId,actorEmail,pageIndex})
hash = H({protocol,seq,prevHash,contentHash})
```

The genesis `prevHash` is 64 zeros. Consecutive links have `seq = previous.seq + 1`
and `prevHash = previous.hash`. `journal.links` includes `{seq,prevHash,contentHash,hash}`
for the exported range, including opaque links for other copies. Detailed events
must match their corresponding links. Duplicate sequence numbers are rejected.
Retained ranges after deletion/retention can begin after genesis. The export does
not certify completeness of omitted event details.

Historical deployed rows can use a flat hash instead of the two-stage formula:

```text
legacyHash = H({protocol,teamId,seq,at,kind,previewId,seatId,actorEmail,pageIndex,prevHash})
```

The verifier recognizes this exact formula from the detailed event, without
rewriting any stored hash or TSA anchor. New links use the split formula above.
A legacy prefix may transition to split links, never back to legacy. New exports
identify legacy links with `hashFormat: "legacy-flat-v1"`. Unknown format labels
and contradictory labels fail verification.

A bare legacy link for another copy hides fields needed to recompute its flat
hash. Its continuity can be checked but its content commitment cannot be
independently verified from this export. Strict verification is therefore
INDETERMINATE for such an opaque legacy link, even if a later anchor exists.
No private fields from other copies are disclosed to bypass that limitation.

`journal.anchors[]` contains `{seq,hash,rfc3161TimeStampRespBase64}`. A timestamp
imprint is the **32 decoded bytes** of the selected link hash. Verify the RFC 3161
response signature, imprint and certificate chain against an independently chosen
trust anchor. All prior links connected to that head are committed by it. A latest
unanchored tail is explicitly incomplete in strict mode.

The platform attempts hourly head sealing at minute 55 and retries pending issuance
timestamps. Failure leaves missing tokens visibly missing. No successful network
response or server-computed hash is substituted for a verified TSA response.

## Independently retained checkpoint

`checkpoint.json` has this minimal format:

```text
{
 format: "privcloud-contractor-checkpoint-v1",
 issuance: {recordHash,rfc3161TimeStampRespBase64},
 journal: {teamId,seq,hash,rfc3161TimeStampRespBase64}
}
```

Retain it outside the server before a suspected compromise. Verify both timestamp
responses and compare the retained `recordHash` and journal `(teamId,seq,hash)`
to the later archive. Missing or different retained head means the later range
cannot establish continuity with that checkpoint. Trusting the checkpoint received
with the later archive is insufficient to prove a prior state.

## Watermark

`MARK_TILE=128`, 32 x 32 chips, amplitude 3 RGB levels, detection threshold 8.
HMAC-SHA256 of UTF-8 `privcloud:forensic-mark:v1:<markId>:<block>` under the team's
32-byte audit key supplies 1024 pseudo-random chip signs over four blocks. The
smooth periodic tile is added to clamped RGB pixels. alpha is unchanged. Detection
estimates scale, folds pixels onto the tile and correlates candidate patterns.
Supported searched scales are 0.35 to 2.5. If aligned detection is inconclusive,
content-based deskew searches a document angle and quadrant rotations before
correlation. Perspective/homography is not corrected. A minimum score gap of 2
is required as well as threshold 8. Competing candidates remain inconclusive.
The embedding and pattern derivation are unchanged. New manifests identify them
with optional `copy.markAlgorithm: "privcloud:forensic-mark:v1"`. historical v1
manifests remain accepted without that field.

New exports may include `rfc3161TimeStampReqBase64` beside issuance and anchor
responses. When present, the verifier compares the saved request with its response
(including the nonce) using OpenSSL. Missing legacy requests are reported.

The `--json` report format is `privcloud-verification-report-v1`. Its status is
`VALID`, `INVALID` or `INDETERMINATE` within the requested technical scope. Strict
exit codes are 0, 1, 2 (malformed input), and 3 (missing required evidence).
Legal identity, qualified TSA status and historical revocation remain explicitly
outside the established result.

The key is required to reconstruct an exact pattern. It is not required to erase
pixels destructively. Pixel recreation, thresholding and some transformations can
remove the mark. Pattern recognition is separate from file-byte integrity checks.
The benchmark uses a public demonstration key, never a production key.

Primary standards: [WebAuthn](https://www.w3.org/TR/webauthn-3/) and
[RFC 3161](https://www.rfc-editor.org/rfc/rfc3161).
