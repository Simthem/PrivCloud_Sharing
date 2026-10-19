import { canonicalJson, sha256Hex } from "src/signing/signing-evidence.util";
import {
  EXTERNAL_PREVIEW_MAX_PAGES,
  isBase64UrlWithin,
} from "./team-external.util";

// Audit of the copies issued to external contractors: the register entry an
// administrator signs with a passkey, and the hash-chained journal of what
// the contractor did with the copy.

export const ISSUANCE_PROTOCOL = "privcloud-contractor-issuance-v1";
export const AUDIT_EVENT_PROTOCOL = "privcloud-contractor-journal-v1";
// Register entries and journal events are evidence for a dispute about a
// leak, then personal data to erase: kept three years.
export const EXTERNAL_AUDIT_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
// Genesis of every team chain.
export const AUDIT_CHAIN_START = "0".repeat(64);

export type AuditEventKind =
  | "ISSUED"
  | "OPENED"
  | "PAGE"
  | "DELETED"
  | "REVOKED"
  // A platform administrator extracted the evidence from the vault.
  | "VAULT";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MARK_ID = /^[a-f0-9]{32}$/;

export type IssuancePageInput = {
  plainSha256: string;
  cipherSha256: string;
  width: number;
  height: number;
};

export type IssuanceInput = {
  markId: string;
  sourceSha256: string;
  pages: IssuancePageInput[];
  visibleMarkAlgorithm?: "privcloud:visible-copy:v1"
  robustMarkAlgorithm?: "privcloud:forensic-multiscale:v2"
};

export type IssuanceManifest = {
  protocol: typeof ISSUANCE_PROTOCOL;
  nonce: string;
  issuedAt: string;
  team: { id: string; name: string };
  issuer: { userId: string; email: string };
  contractor: { seatId: string; email: string; name: string | null };
  accessExpiresAt: string;
  copy: {
    markAlgorithm?: "privcloud:forensic-mark:v1";
    visibleMarkAlgorithm?: "privcloud:visible-copy:v1"
    robustMarkAlgorithm?: "privcloud:forensic-multiscale:v2"
    previewId: string;
    sourceFileId: string;
    sourceSha256: string;
    markId: string;
    pageCount: number;
    pages: IssuancePageInput[];
  };
};

/** What the browser of the administrator alone can compute. */
export function isValidIssuanceInput(
  value: unknown,
  pageCount: number,
): value is IssuanceInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<IssuanceInput>;
  return (
    typeof input.markId === "string" &&
    (input.visibleMarkAlgorithm === undefined || input.visibleMarkAlgorithm === "privcloud:visible-copy:v1") &&
    (input.robustMarkAlgorithm === undefined || input.robustMarkAlgorithm === "privcloud:forensic-multiscale:v2") &&
    MARK_ID.test(input.markId) &&
    typeof input.sourceSha256 === "string" &&
    SHA256_HEX.test(input.sourceSha256) &&
    Array.isArray(input.pages) &&
    input.pages.length === pageCount &&
    pageCount <= EXTERNAL_PREVIEW_MAX_PAGES &&
    input.pages.every(
      (page) =>
        !!page &&
        typeof page.plainSha256 === "string" &&
        SHA256_HEX.test(page.plainSha256) &&
        typeof page.cipherSha256 === "string" &&
        SHA256_HEX.test(page.cipherSha256) &&
        Number.isInteger(page.width) &&
        page.width > 0 &&
        page.width <= 10000 &&
        Number.isInteger(page.height) &&
        page.height > 0 &&
        page.height <= 10000,
    )
  );
}

export function buildIssuanceManifest(input: {
  nonce: string;
  issuedAt: Date;
  team: { id: string; name: string };
  issuer: { userId: string; email: string };
  contractor: { seatId: string; email: string; name: string | null };
  accessExpiresAt: Date;
  previewId: string;
  sourceFileId: string;
  client: IssuanceInput;
}): IssuanceManifest {
  return {
    protocol: ISSUANCE_PROTOCOL,
    nonce: input.nonce,
    issuedAt: input.issuedAt.toISOString(),
    team: input.team,
    issuer: input.issuer,
    contractor: input.contractor,
    accessExpiresAt: input.accessExpiresAt.toISOString(),
    copy: {
      markAlgorithm: "privcloud:forensic-mark:v1",
      ...(input.client.visibleMarkAlgorithm ? { visibleMarkAlgorithm: input.client.visibleMarkAlgorithm } : {}),
      ...(input.client.robustMarkAlgorithm ? { robustMarkAlgorithm: input.client.robustMarkAlgorithm } : {}),
      previewId: input.previewId,
      sourceFileId: input.sourceFileId,
      sourceSha256: input.client.sourceSha256,
      markId: input.client.markId,
      pageCount: input.client.pages.length,
      pages: input.client.pages.map((page) => ({
        plainSha256: page.plainSha256,
        cipherSha256: page.cipherSha256,
        width: page.width,
        height: page.height,
      })),
    },
  };
}

/**
 * The WebAuthn challenge is the SHA-256 of the canonical manifest: anyone
 * holding the manifest can check that the passkey signed exactly it.
 */
export function issuanceChallenge(manifest: IssuanceManifest) {
  const canonical = canonicalJson(manifest);
  return { canonical, hash: sha256Hex(canonical) };
}

/** Imprint of the RFC 3161 timestamp: the manifest and the signature over it. */
export function issuanceRecordHash(record: {
  manifest: string;
  credentialId: string;
  credentialPublicKey: string;
  credentialAlgorithm: number;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}) {
  return sha256Hex(
    canonicalJson({
      protocol: ISSUANCE_PROTOCOL,
      manifest: record.manifest,
      credentialId: record.credentialId,
      credentialPublicKey: record.credentialPublicKey,
      credentialAlgorithm: record.credentialAlgorithm,
      authenticatorData: record.authenticatorData,
      clientDataJSON: record.clientDataJSON,
      signature: record.signature,
    }),
  );
}

export type AuditEventContent = {
  teamId: string;
  seq: number;
  at: Date;
  kind: string;
  previewId: string | null;
  seatId: string | null;
  actorEmail: string;
  pageIndex: number | null;
  prevHash: string;
};

/**
 * What an event says, committed apart from its link: the evidence of one copy
 * shows the events of other copies as bare links, without their content.
 */
export function auditEventContentHash(
  event: Omit<AuditEventContent, "seq" | "prevHash">,
) {
  return sha256Hex(
    canonicalJson({
      protocol: AUDIT_EVENT_PROTOCOL,
      teamId: event.teamId,
      at: event.at.toISOString(),
      kind: event.kind,
      previewId: event.previewId,
      seatId: event.seatId,
      actorEmail: event.actorEmail,
      pageIndex: event.pageIndex,
    }),
  );
}

export function auditLinkHash(link: {
  seq: number;
  prevHash: string;
  contentHash: string;
}) {
  return sha256Hex(
    canonicalJson({
      protocol: AUDIT_EVENT_PROTOCOL,
      seq: link.seq,
      prevHash: link.prevHash,
      contentHash: link.contentHash,
    }),
  );
}

/** Each event commits to the previous one: no row can change unnoticed. */
export function auditEventHash(event: AuditEventContent) {
  return auditLinkHash({
    seq: event.seq,
    prevHash: event.prevHash,
    contentHash: auditEventContentHash(event),
  });
}

/** Historical format confirmed in early deployed journals. Read only. */
export function legacyAuditEventHash(event: AuditEventContent) {
  return sha256Hex(canonicalJson({
    protocol: AUDIT_EVENT_PROTOCOL,
    teamId: event.teamId,
    seq: event.seq,
    at: event.at.toISOString(),
    kind: event.kind,
    previewId: event.previewId,
    seatId: event.seatId,
    actorEmail: event.actorEmail,
    pageIndex: event.pageIndex,
    prevHash: event.prevHash,
  }))
}

export function auditEventHashFormat(event: AuditEventContent & { hash: string }) {
  if (auditEventHash(event) === event.hash) return "split-v1" as const
  if (legacyAuditEventHash(event) === event.hash) return "legacy-flat-v1" as const
  return null
}

/**
 * Walks a chain in order. Events older than the retention may be gone: the
 * first remaining one is trusted for its previous hash, everything after it
 * must link up and every anchor must match the event it timestamps.
 */
export function verifyAuditChain(
  events: (AuditEventContent & { hash: string })[],
  anchors: { seq: number; hash: string }[],
): {
  valid: boolean
  brokenAtSeq: number | null
  reason?: "content_hash_mismatch" | "genesis_mismatch" | "sequence_gap" | "previous_hash_mismatch" | "anchor_mismatch" | "format_downgrade"
} {
  const bySeq = new Map<number, string>();
  let previous: (AuditEventContent & { hash: string }) | null = null;
  let splitSeen = false
  for (const event of events) {
    const format = auditEventHashFormat(event)
    const reason = !format
      ? "content_hash_mismatch"
      : splitSeen && format === "legacy-flat-v1"
        ? "format_downgrade"
      : event.seq === 1 && event.prevHash !== AUDIT_CHAIN_START
        ? "genesis_mismatch"
        : previous && event.seq !== previous.seq + 1
          ? "sequence_gap"
          : previous && event.prevHash !== previous.hash
            ? "previous_hash_mismatch"
            : null
    if (reason) return { valid: false, brokenAtSeq: event.seq, reason }
    if (format === "split-v1") splitSeen = true
    bySeq.set(event.seq, event.hash);
    previous = event;
  }
  for (const anchor of anchors) {
    const hash = bySeq.get(anchor.seq);
    if (hash !== undefined && hash !== anchor.hash) {
      return { valid: false, brokenAtSeq: anchor.seq, reason: "anchor_mismatch" }
    }
  }
  return { valid: true, brokenAtSeq: null };
}

/** Title of the document under the team audit key, never read here. */
export function isValidEncryptedLabel(value: unknown): value is string {
  return typeof value === "string" && isBase64UrlWithin(value, 1024);
}

/** K_audit wrapped with K_team: IV, 32 bytes and tag, base64url. */
export function isValidEncryptedAuditKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    value.length >= 70 &&
    value.length <= 200
  );
}
