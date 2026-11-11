# Scanner policies

## Locally patched fflate

SNYK-JS-FFLATE-22392372 / CVE-2026-122146 affects the upstream fflate 0.8.3
artifact. This repository applies a local ZIP allocation guard. It does not
claim that the npm release is fixed.

The root and frontend `.snyk` files share one exception limited to dependency
paths ending in `fflate@0.8.3`. It expires on 2026-11-25. The root policy is
used by scans with `--policy-path=.snyk`, including container scans. The
frontend policy covers scans that discover `frontend/package-lock.json`
directly. Other versions, findings and packages keep their normal treatment.

Installation and prebuild hooks verify all six fflate entry points, including
cached Docker builders. Frontend tests reproduce excessive size declarations
without allocating the requested memory, verify worker limits, and check
legitimate extraction and streamed ZIP creation. They also check policy parity,
VEX scope and the release workflow. The release gate runs them as part of its frontend suite.

Run the focused checks after installing the locked dependencies:

```sh
cd frontend
node --test test/fflate-security.test.mjs
```

Review the exception by its expiry and whenever the guard, build hooks,
extraction paths or fflate version changes. Remove it when replacing the local
patch with a reviewed upstream fix. An unpatched npm artifact is not covered.

## Docker Scout and other VEX consumers

The OpenVEX document records `not_affected` with
`inline_mitigations_already_exist` only for this repository's patched copy of
`pkg:npm/fflate@0.8.3`. Its impact statement records the bounds, evidence and
2026-11-25 review date. OpenVEX has no automatic expiry equivalent to `.snyk`.
Update or withdraw the statement after reassessment.

Both Dockerfiles copy the complete document into the final image as
`/usr/share/security/privcloud.vex.json`. Scout can discover this file in images
without attestations. The `security:scout` command supplies this document and its author explicitly,
filters only CVEs marked not affected, and fails on remaining findings. Use
`local://` to prevent a registry fallback during local analysis:

```sh
npm run security:scout -- local://IMAGE
```

Scout ignores embedded VEX files when an image already has attestations. In
that case, the release operator must attach the complete document to the exact
published image digest, using the repository's VEX path:

```sh
docker scout attestation add --file .docker/vex.json --predicate-type https://openvex.dev/ns/v0.2.0 IMAGE_DIGEST
```

No registry attestation is added by these source changes. Scanners that do not
consume OpenVEX can still report the unchanged upstream version. Do not disable
their entire package scan to hide that result.

References: [Snyk ignore policy](https://docs.snyk.io/developer-tools/snyk-cli/commands/ignore),
[Docker Scout OpenVEX](https://docs.docker.com/scout/how-tos/create-exceptions-vex/).

## Historical JWT claim recovery

The provider recovery primitive first authenticates the compact JWS with the
provider's JWKS. Only then can its signed `iat` and `nbf` select a historical
validity date. A full `jwtVerify` checks the JWT structure, required temporal
claims, audience and issuer at that date. Subject and verified-email policy
must still match before an address is returned.

This historical date is used only to recover claims from stored sessions.
Normal sign-in continues to use the current clock and rejects expired tokens.
There is no decode-only fallback or Snyk Code exclusion. If a signing key is
no longer published, the token cannot be verified and recovery skips it. An
address already recorded is retained. The next valid provider sign-in records
the verified address through the normal path.

Regression tests cover forged signatures, payload tampering, unsigned tokens,
issuer/audience/subject mismatches, invalid or future validity dates, unavailable
keys, authentic expired sessions and their rejection for current sign-in.

The legacy indexing job delegates each stored provider token to this verifier.
It skips unavailable providers or failed verification and writes no address
until a verified result is available.

Refresh of existing address indexes runs independently of historical token
verification, so an unavailable provider cannot hold up that local refresh.
