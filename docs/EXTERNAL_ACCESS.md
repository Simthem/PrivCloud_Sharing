# External contractor access

Team administrators can issue temporary, preview-only access to external
contractors. A contractor is a separate kind of account access, never a Team
member. Someone with an active or pending contractor access must have it revoked
before joining that Team as a member.

Set `TEAM_MAX_EXTERNAL_SEATS` to a non-negative integer to limit active and pending
accesses per Team. The default `0` leaves their number unrestricted. Page size,
page count, invitation lifetime and access duration remain bounded independently
of this setting. A copy contains at most 300 pages and an access lasts at most
90 days.

## Invitation and publication

1. Unlock the Team key and configure the encrypted company profile in Team
   settings if company details should appear in the watermark.
2. Invite the contractor using their account email and an access end date.
3. The contractor accepts using the invited account, enables two-factor
   authentication and prepares the compatible encryption keys.
4. An administrator selects a supported Team file. The browser decrypts it
   locally, renders bounded page images and applies the contractor's watermark.
5. The administrator confirms the issuance manifest with a passkey. The copy
   becomes available only after every encrypted page matches that manifest.

The contractor receives a preview key wrapped for their X25519 and ML-KEM-768
keys. They receive neither the original file nor the Team key. Page requests
recheck the authenticated account, source, access dates, revocation and stored
ciphertext. Allowing anonymous uploads does not allow anonymous preview access.

Revocation hides a copy immediately. Cleanup removes pages after revocation,
expiry, source deletion or an abandoned upload. Deleting a Team also removes its
stored copies.

## Evidence and retention

The Team register records the issuance manifest and its WebAuthn confirmation.
Access events form a hash chain. Timestamp tokens and anchors are retained with
their evidence when available. A failed timestamp request does not become a
successful timestamp claim.

Team deletion does not delete retained issuance records, journals or anchors.
Platform administrators use the evidence vault, unlocked briefly with their own
passkey, to access retained evidence. The configured audit retention and explicit
vault erasure govern its lifetime. Preview storage and audit evidence have
different lifecycles.

The independently usable tools are in `verification/contractor`. Frontend builds
generate `/verification/contractor/`, its archive and checksums. Verification in
strict mode requires independently supplied trust anchors, expected origin, RP
ID, original file and a previously retained checkpoint. See the tool's README
and format specification for commands and result meanings.

The browser performs watermark analysis locally. A compatible pattern is an
investigation lead. It does not establish who disclosed a document. Team key
holders can create patterns, captures can remove marks, and several plausible
sources must remain inconclusive. Visible pages can still be photographed or
captured. Preview-only access cannot prevent that.

## Upgrading

Back up the SQLite database and stored files before upgrading. Apply the normal
application migrations, including
`20261019120000_add_external_access_and_passkeys`, before starting the updated
backend. This migration adds tables without rewriting existing shares or files.
An older backend will not manage the new preview and evidence lifecycles.

Resumable Team key rotation covers profiles, audit keys and encrypted activity
names as well as existing encrypted share and request metadata. Use that workflow
when ciphertext already exists under the current Team key.
