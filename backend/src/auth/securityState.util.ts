import { User } from "@prisma/client";
import { randomBytes, scrypt, timingSafeEqual } from "crypto";

// Credentials that a pending account change must outlive unchanged: a new
// password, directory link or second factor voids it.
type SecurityFields = Pick<
  User,
  "password" | "ldapDN" | "totpEnabled" | "totpVerified" | "totpSecret"
>;

const KEY_BYTES = 32;
const SALT_BYTES = 16;

function material(user: SecurityFields): string {
  return JSON.stringify([
    user.password,
    user.ldapDN,
    user.totpEnabled,
    user.totpVerified,
    user.totpSecret,
  ]);
}

function derive(user: SecurityFields, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(material(user), salt, KEY_BYTES, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export function sameSecurityState(a: SecurityFields, b: SecurityFields) {
  return material(a) === material(b);
}

/** A salted, slow fingerprint: the stored value reveals nothing usable. */
export async function sealSecurityState(user: SecurityFields) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(user, salt);
  return `${salt.toString("base64url")}.${key.toString("base64url")}`;
}

/**
 * Whether the account still has the credentials it had when sealed. Values
 * written before salting are not accepted: those requests start again.
 */
export async function matchesSecurityState(
  sealed: string,
  user: SecurityFields,
) {
  const [salt, key, ...rest] = sealed.split(".");
  if (!salt || !key || rest.length) return false;
  const expected = Buffer.from(key, "base64url");
  if (expected.length !== KEY_BYTES) return false;
  const actual = await derive(user, Buffer.from(salt, "base64url"));
  return timingSafeEqual(actual, expected);
}
