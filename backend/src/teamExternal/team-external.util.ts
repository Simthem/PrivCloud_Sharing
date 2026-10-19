import { BadRequestException } from "@nestjs/common";
import { createHash } from "crypto";

// Instance limit for external access. Zero leaves the seat count unrestricted.
const configuredSeats = process.env.TEAM_MAX_EXTERNAL_SEATS || "0";
if (
  !/^\d+$/.test(configuredSeats) ||
  !Number.isSafeInteger(Number(configuredSeats))
) {
  throw new Error(
    "TEAM_MAX_EXTERNAL_SEATS must be a non-negative safe integer",
  );
}
export const EXTERNAL_SEAT_LIMIT = Number(configuredSeats);
export const EXTERNAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXTERNAL_ACCESS_MIN_MS = 60 * 60 * 1000;
export const EXTERNAL_ACCESS_MAX_DAYS = 90;
// Rendered pages are bounded images, a page above this size is not one.
export const EXTERNAL_PREVIEW_MAX_PAGES = 300;
export const EXTERNAL_PAGE_MAX_BYTES = 6 * 1024 * 1024;
// [IV 12 bytes][AES-256-GCM ciphertext][tag 16 bytes], never empty.
export const EXTERNAL_PAGE_MIN_BYTES = 12 + 16 + 1;
export const EXTERNAL_PREVIEWS_PER_SEAT = 200;
export const EXTERNAL_MANIFEST_MAX_LENGTH = 64000;
// Abandoned uploads are purged once this old.
export const EXTERNAL_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
// Revoked and expired seats stay listed for this long, then disappear.
export const EXTERNAL_SEAT_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

// Copies for a contractor are always post-quantum: no X25519-only wrapping.
export const EXTERNAL_WRAPPING_ALGORITHM = "x25519-mlkem768-aes256gcm";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExternalSeatState = {
  status: string;
  userId: string | null;
  inviteExpiresAt: Date;
  accessExpiresAt: Date;
};

export type ExternalSeatStatus = "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";

export function hashExternalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** An accepted, unexpired seat bound to an account. */
export function isSeatUsable(seat: ExternalSeatState, now: Date): boolean {
  return (
    seat.status === "ACTIVE" &&
    !!seat.userId &&
    seat.accessExpiresAt.getTime() > now.getTime()
  );
}

/** Seats taking one of the EXTERNAL_SEAT_LIMIT places. */
export function seatTakesPlace(seat: ExternalSeatState, now: Date): boolean {
  if (seat.accessExpiresAt.getTime() <= now.getTime()) return false;
  if (seat.status === "ACTIVE") return true;
  return (
    seat.status === "PENDING" && seat.inviteExpiresAt.getTime() > now.getTime()
  );
}

export function displayedSeatStatus(
  seat: ExternalSeatState,
  now: Date,
): ExternalSeatStatus {
  if (seat.status === "REVOKED") return "REVOKED";
  if (seat.accessExpiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (seat.status === "ACTIVE") return seat.userId ? "ACTIVE" : "REVOKED";
  return seat.inviteExpiresAt.getTime() > now.getTime() ? "PENDING" : "EXPIRED";
}

/** End of access chosen by an admin: at least one hour, at most 90 days. */
export function parseAccessExpiry(value: string, now: Date): Date {
  const date = new Date(value);
  const time = date.getTime();
  if (
    !Number.isFinite(time) ||
    time < now.getTime() + EXTERNAL_ACCESS_MIN_MS ||
    time > now.getTime() + EXTERNAL_ACCESS_MAX_DAYS * 24 * 60 * 60 * 1000
  ) {
    throw new BadRequestException(
      `The access must end between one hour and ${EXTERNAL_ACCESS_MAX_DAYS} days from now`,
    );
  }
  return date;
}

/** Storage key of one page. Both parts are validated, none comes from a path. */
export function externalPreviewPageKey(previewId: string, index: number) {
  if (
    !UUID.test(previewId) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= EXTERNAL_PREVIEW_MAX_PAGES
  ) {
    throw new BadRequestException("Invalid preview page");
  }
  return `external-previews/${previewId}/${index}.bin`;
}

/** Exact decoded length check of a base64url value without padding. */
export function isBase64UrlOfLength(value: unknown, bytes: number): boolean {
  return (
    typeof value === "string" &&
    BASE64URL.test(value) &&
    value.length === Math.ceil((bytes * 4) / 3)
  );
}

export function isBase64UrlWithin(value: unknown, maxLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    BASE64URL.test(value)
  );
}

/** Sizes of a hybrid wrapping, as produced by hybridWrapDEK on the client. */
export function isValidHybridWrapping(wrapping: {
  encryptedKey: unknown;
  ephemeralPublicKey: unknown;
  nonce: unknown;
  kemCiphertext: unknown;
  algorithm: unknown;
}): boolean {
  return (
    wrapping.algorithm === EXTERNAL_WRAPPING_ALGORITHM &&
    // 32-byte AES-256 key and its 16-byte GCM tag.
    isBase64UrlOfLength(wrapping.encryptedKey, 48) &&
    isBase64UrlOfLength(wrapping.ephemeralPublicKey, 32) &&
    isBase64UrlOfLength(wrapping.nonce, 12) &&
    // ML-KEM-768 ciphertext.
    isBase64UrlOfLength(wrapping.kemCiphertext, 1088)
  );
}
