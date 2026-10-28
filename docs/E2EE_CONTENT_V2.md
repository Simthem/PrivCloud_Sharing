# E2EE content format v2

Status: the current clients read v1 and v2 and write v2 for every new E2EE
upload. Key and identity policies determine the admissible format. Backend
switches reject incompatible older writers, they cannot lower the current
client's minimum. Implementation: `frontend/src/utils/contentV2.util.ts`.
Deployment and rollback: `E2EE_CONTENT_V2_ROLLOUT.md`.

## Guarantees

For one file, a reader that accepts v2 content knows that:

- every record was produced for this file, at this position
- no record was removed, added, duplicated or moved
- the content ends where its writer ended it
- the format parameters are the ones the writer used.

Under a key with a v2 floor, the reader also knows that the content is v2:
v1 content, including an empty object, is refused.

The format does not provide:

- freshness. When several complete states of one file exist under one key,
  an older one still reads. Freshness needs a trust anchor outside the server.
  A complete older authenticated state of the same identity is not rejected
  merely because a newer state exists.
- authorship. Anyone holding the content key can write valid content.
- completeness of a share listing. The server can still hide a file, or list
  a file of another share that uses the same key.
- a global minimum for every historical context under an old link. A valid
  historical entry may still be replayed or listed instead of another entry.
  The expected identity and its authenticated description must be preserved.
  A listing is not an authenticated manifest or a freshness anchor.

## Layout

```
[header 32][record 0][record 1]...[record n-1]
record = [IV 12][ciphertext + GCM tag 16]
```

Header, all integers big endian:

| Offset | Length | Value |
|---|---|---|
| 0 | 8 | magic `89 50 43 45 32 0D 0A 1A` |
| 8 | 1 | version, `2` |
| 9 | 1 | flags, `0` |
| 10 | 4 | record size, `1000000` |
| 14 | 16 | file nonce, random per write |
| 30 | 2 | reserved, `0` |

A reader refuses any other value. Records hold 1,000,000 plaintext bytes,
except the last one, which holds 1 to 1,000,000 bytes. An empty file has a
single final record of 0 bytes, so the smallest v2 object has 60 bytes. A last
record of 0 bytes after other records is not a valid encoding, and writers
refuse to produce one.

## Identity

`field(x)` is a 2-byte length followed by the UTF-8 bytes of `x`.

- Share files, including Team, reverse share and Companion uploads:
  `identity = field("share-file") || field(fileId)`.
- Signed results of an end-to-end encrypted signing request:
  `identity = field("signing-document") || field(documentId)`.

The file identifier is created by the client before the first byte, is unique
across shares and is not a capability. The share identifier is left out on
purpose: it is the capability of the share link, and readers such as signers
never receive it. A writer that is answered with another file identifier
stops, since its records are bound to the one it chose.

## Context minimum and historical coexistence

The current client creates new E2EE shares in the `v2.` namespace. A dot was
not permitted in historical share identifiers. New files use UUIDv8, reserved
by these clients for v2 contexts. Historical writers generated UUIDv4. New
E2EE signing requests also choose a UUIDv8 document identity before creation.
Neither marker is a key generation or a server-declared content version.

A reader that expects one of these identities requires v2 independently of
`contentScheme`, sizes and other server descriptions. A response that changes
the requested share or signing-document identity is rejected. Missing key
material or a false plaintext claim cannot select the plaintext reader for
an expected protected context. A new personal share also requires its owner
envelope instead of falling back to the account key.

Encrypted file metadata authenticates the share and file identifiers, the
name, path and optional minimum `c: 2`. Failed metadata authentication blocks
the same content identity. Legacy metadata can omit `c`. A verified minimum
is retained across key imports during the current page session. This cache
is not a freshness anchor. New identities carry their minimum even before
metadata is opened. A complete replacement by another valid historical entry
changes the logical identity and is outside listing integrity guarantees.

A historical bare-key link cannot make an older client enforce the new
protocol against a compromised server. The normal upgraded backend rejects
such writers after activation. A compromised server can still accept old
writers and present their valid old-style contexts as historical entries.
The current reader cannot infer a trusted creation date from that listing.
A cryptographic cutoff for all future deposits needs a new immutable trust
carrier and controlled withdrawal of the old write capability, or an
authenticated manifest with an external monotonic anchor. Keeping the exact
old capability while claiming that cutoff would be incorrect. This release
does not revoke or silently replace that capability.

An existing personal or SHARE_DEK_V1 share keeps its identifier and root key.
New file subkeys use v2, old files remain v1. Existing reverse links retain
their token and symmetric secret. A current depositor creates a new v2 child
context without needing the owner's master key or replacing the deposit.
Team adoption likewise keeps member envelopes, keyVersion, ACLs and old
files. It needs no root rotation because HKDF already separates new file
keys. Explicit security rotation remains distinct where the product supports
it. It does not revoke keys or plaintext already copied by a former member.

## Keys

The file key is HKDF-SHA256 with the content key as input keying material, an
empty salt and `info = field("privcloud:content:v2:key") || header || identity`.
It is an AES-256-GCM key used for this object only. The content key is the
share, Team, reverse share or legacy account key that protects the file.

A new write draws a new file nonce, so a rewrite or re-encryption never reuses
the key of an earlier state. An interrupted upload resumes with the nonce of
its first session, kept with its resume state, so that every part is under the
same file key. IVs are random.

## Additional data

```
aad(index, last) = field("privcloud:content:v2:record") || header || identity
                   || index (8 bytes) || last (1 byte, 1 for the last record)
```

The header is authenticated twice: through the key derivation and in each
record. The record count comes from the stored length. A wrong length makes
the record read as last fail, because it was not encrypted as last.

## Content keys with a v2 floor

New content keys carry `[0x02][32-byte key]` rather than a bare key. The
policy travels inside an authenticated envelope or the trusted link fragment.
The reader refuses v1, including a zero-byte object, under that capability.
The current client creates these keys automatically, independent of runtime
flags. The account master key remains unchanged and carries no global floor.

A new signature of a historical v1 source must still read that source. Its
capability can instead carry `[0x03][32-byte key]`: v1 remains readable for
the source-file context, but signed-result contexts require v2. Its new writes
are v2. This policy survives link and encrypted recipient-key transport. A
capability with the global policy 0x02 keeps that stronger policy. A signing
capability without an explicit content context is refused.

The policy byte describes admissible content, not a generation of key
material. Restricting a new child context of a historical reverse or Team
root does not rotate that root, revoke old links or strengthen historical v1
records. Existing carriers are never silently rewritten to claim revocation.

## Reading

- v2 is recognized by its magic, never by a server field or header.
  `X-Encryption-Chunk-Size`, `encryptionChunkSize` and `File.contentScheme`
  are ignored by readers.
- Content that starts with the magic is never read as v1. A reader without the
  identity refuses it.
- A sequential read fixes the total length from the first response. A stream
  that ends early, even on a record boundary, or delivers more bytes, fails.
- A random access read takes the header from the first range, the total
  length from `Content-Range`, record `i` from offset `32 + i * 1000028`, and
  marks as last the record that the total length designates. A preview
  authenticates the records it reads. Unread records are checked when they
  are requested. Whole-file completion requires verification through the
  final record.
- A decryption failure raises `ContentIntegrityError`. No partial plaintext of
  a failed record is returned.

## Writers

All of them are read back by the reference reader in the tests.

| Writer | Code |
|---|---|
| Web and PWA uploads | `frontend/public/upload-worker.js`, `frontend/src/utils/upload.util.ts` |
| Re-encryption | `reencryptStream` in `frontend/src/utils/crypto.util.ts` |
| Signed results | `frontend/src/pages/signing/[id].tsx` |
| Companion | `bridge/src/direct-upload.mjs`, `bridge/src/privcloud-bridge.mjs` |

A re-encryption of v2 content writes v2, never v1. A signed result is written
in v2 when its source is v2, under a floored key, or when v2 writes are on.

## Server

The server stores opaque bytes. A v2 upload declares `contentScheme=2`, uses
1,000,000-byte records and a client file identifier. The first part carries
32 more bytes, which every size check accounts for. When the first part passes
through the server, its fixed header bytes are checked. `File.contentScheme`
records the declared format for operations, `NULL` meaning v1.

A new end-to-end encrypted upload in a v2 context, or while
`share.contentV2Writes` is on, that
does not declare v2 is refused with HTTP 409 and the code
`e2ee_content_v2_required`, before anything is stored. A new v2 upload resumes
with its original file identity and nonce. An unfinished v1 transfer may need
to restart with a new v2 identity after activation. Completed historical files
are untouched. v2 is accepted whether the switch is on or off.
Re-encryption accepts both formats, so that a rotation can always complete.

## Errors

`ContentIntegrityError` names content that is not what its writer produced.
Network and storage errors keep their own types.

A v2 per-file metadata envelope is accepted in a historical share without
changing that share's metadata scheme or old rows. Native adds nullable owner
key and metadata columns through `20261027160000_share_key_envelopes`.
Encryption and wrapping remain client-side. No server-owned content
decryption key is introduced. The optional SaaS email channel below
explicitly receives the content key when selected.

Signed results under a new UUIDv8 document identity must have a v2 header
before storage. Re-encryption commits encrypted metadata together with the
stored size and format. A legacy zero-byte source becomes a 60-byte v2 object
when a voluntary rotation targets v2. Adoption never invokes this historical
rewrite automatically.

A separate explicit Team rotation also encrypts historical plain file names
and paths before publishing v2 content under a floored key. Storage updates
the encrypted description, metadata scheme, placeholder, size and format in
one database operation. A lost response is recovered only after the stored
name authenticates under the new key and every content record verifies.
The original plaintext name was not authenticated retroactively. The new
envelope authenticates the value the authorized rotating client observed.

## Optional direct SaaS email delivery

The existing explicit option to email the complete link through the SaaS is
preserved. It sends the content key to the backend so that it can compose the
recipient email. This opt-in channel is outside the zero-knowledge guarantee.
It does not weaken the v2 record format, but the server must be trusted with
the key for this delivery. With the option off, the fragment stays client-side.
Reverse-share completion never forwards the owner's deposit key.
