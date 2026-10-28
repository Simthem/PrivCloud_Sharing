# E2EE content v2: deployment and rollback

The current client writes v2 automatically, including in historical shares. It
creates new content keys with a floor and new file identities with a minimum
format. No account key reset, share recreation or historical rewrite is part
of adoption. Format and limits: `E2EE_CONTENT_V2.md`.

## Deployment window

1. Build the backend, web client, Native application and Companion from the
   same sources. Native must include the newly exported web assets through
   `cap sync android`. Install Native and Companion before enabling old-client
   rejection. Companion health must advertise `capabilities.contentV2`.
2. Back up the database and encrypted storage through the normal procedure.
   Apply the additive migrations with
   `node node_modules/prisma/build/index.js migrate deploy` from `backend`.
   Do not change or delete stored keys, historical metadata or encrypted objects.
3. Route all E2EE creation, upload, multipart, re-encryption and signing writes
   to the new backend before publishing the new frontend. N-1 cannot serve
   the new share namespace. Database coexistence alone is not protocol support.
4. Set `share.contentV2Writes` to true on the new backend to reject stale web
   and PWA v1 uploads with `e2ee_content_v2_required`. Keep
   `SHARE_DEK_V1_READ` enabled. The existing `share.contentV2Floor` setting may
   remain enabled for intermediate clients. Neither switch can lower the
   compiled minimum of this client or strip a policy already carried by a key.
5. Publish the matching web assets. An old open tab must update or reload
   before uploading. New v2 identities refuse v1 even when the global server
   gate is off. The Gmail add-on source accepts the new share namespace. The
   source distribution retains its existing packaging model.

Existing downloadable Native and Companion binaries are preserved. Build and
version their replacements through the normal release pipeline. A previously
published archive is not evidence of v2 capability, the running Companion
must advertise it. The local Android build is a debug validation with a
fixture API origin, not a production-signed release.

`E2EE_CONTENT_V2_WRITES` and `E2EE_CONTENT_V2_FLOOR` remain deployment defaults
for the backend switches. A saved administration value takes precedence.
Changing these values is not a cryptographic key rotation.

## Preproduction checks

Use disposable accounts and both local storage and S3. Keep production out
of the checks.

- Create a personal share, a reverse share and, where supported, a Team.
  Verify encryption, download, preview and the empty-file case.
- Reopen a historical v1 share and append a new file. Its old identifier,
  permissions, recipients and expiration stay intact. The old file remains
  v1, the new file has a UUIDv8 identity and is written in v2.
- Use an existing reverse upload link, anonymously and authenticated. The
  parent token, secret, quotas and history stay unchanged. New deposits use
  v2 contexts. Test expiration, revoked access and interrupted uploads.
- Open Team content from two authorized clients. Adoption keeps existing
  member envelopes and keyVersion, while new file subkeys use v2. Test a
  separate explicit security rotation, interruption, resumption and a revoked
  member. Do not treat format adoption as revocation of copied root keys.
- Sign both a v1 source and a v2 source. A current signing capability permits
  its historical source but requires v2 for its new signed result. Reopen the
  result through the recipient link and the account's wrapped key.
- Alter a record, its position, the header, total length and encrypted file
  metadata. Strip the declared scheme or present v1 for an expected v2
  identity. The current reader must fail, including previews and resumed reads.
- Check old bundles and cached PWA tabs against the new backend. They must
  receive an update/reload error, never successfully finalize a v1 upload for
  a context that requires v2.

The `File.contentScheme` column is an operational check only. Confirm the
actual bytes with the current reader, not just with a SQL value or HTTP 200.
For completed share uploads, confirm the persisted file identifier and
`uploadPending: false` through the normal completion path.

## Rollback

Keep the additive schema, all key carriers and encrypted objects. Do not
replace UUIDv8 identities, remove key policy bytes or relabel v2 as v1.

The current frontend keeps writing v2 when either backend switch is disabled.
For an incident, pause creation and encrypted write routes through the normal
maintenance routing, retain the current readers and deploy a corrected build.
Do not send v2 writes to N-1. Do not roll back to a reader that ignores the
new identity minimum or the signing policy. Authentication, key retrieval and
historical reads must remain available during a write pause.

An old link stays a historical capability. Adoption neither revokes it nor
proves the freshness or completeness of a server-provided listing. A global
revocation or a new immutable trust carrier is a separate operation with
explicit access consequences.

Keeping a historical link also keeps its historical write capability. With a
compromised server, an old writer can still produce old-style contexts. This
release guarantees v2 for an expected protected identity, not a trusted date
cutoff for the whole historical deposit. Replacing a link's presentation
alone does not revoke the old secret. Any actual withdrawal of that access
requires a separate, explicit sharing decision.

The existing opt-in for direct SaaS email delivery of the complete link is
preserved. In that mode the content key reaches the mail-composing backend,
so that delivery channel is outside zero-knowledge. Keep the option explicit
and test notification links with it both enabled and disabled. Reverse-share
owner keys remain excluded from completion mail in every case.
