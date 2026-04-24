/**
 * SSKR -- Sharded Secret Key Recovery
 *
 * Shamir Secret Sharing over GF(2^8) with irreducible polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D), primitive element 2.
 *
 * All computation is client-side. The server never sees the shards.
 */

// ---- GF(256) arithmetic ---------------------------------------------------

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  EXP[255] = EXP[0];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF(256) division by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

// ---- Shamir SSS -----------------------------------------------------------

function polyEval(coeffs: Uint8Array, x: number): number {
  let r = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    r = gfMul(r, x) ^ coeffs[i];
  }
  return r;
}

function shamirSplit(
  secret: Uint8Array,
  t: number,
  n: number,
): Uint8Array[] {
  if (t < 2 || t > n || n > 255)
    throw new Error("Invalid threshold/total");

  const shares: Uint8Array[] = [];
  for (let i = 0; i < n; i++) shares.push(new Uint8Array(secret.length));

  const coeffs = new Uint8Array(t);
  for (let b = 0; b < secret.length; b++) {
    coeffs[0] = secret[b];
    crypto.getRandomValues(coeffs.subarray(1));
    for (let i = 0; i < n; i++) {
      shares[i][b] = polyEval(coeffs, i + 1);
    }
  }
  return shares;
}

function shamirCombine(xs: number[], shares: Uint8Array[]): Uint8Array {
  const t = xs.length;
  if (t < 2) throw new Error("Need >= 2 shares");
  const len = shares[0].length;
  const result = new Uint8Array(len);

  for (let b = 0; b < len; b++) {
    let val = 0;
    for (let i = 0; i < t; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < t; j++) {
        if (i === j) continue;
        num = gfMul(num, xs[j]);
        den = gfMul(den, xs[i] ^ xs[j]);
      }
      val ^= gfMul(shares[i][b], gfDiv(num, den));
    }
    result[b] = val;
  }
  return result;
}

// ---- Shard binary format --------------------------------------------------
//
// Layout (38 bytes for AES-256) :
//   [0]     version   (1)
//   [1]     threshold T
//   [2]     total     N
//   [3]     index     (1-based)
//   [4..35] share data (32 bytes for AES-256)
//   [36]    fletcher-16 sum1
//   [37]    fletcher-16 sum2
//
// Encoded string : "sskr:" + base64url(38 bytes) -> ~55 characters

const SSKR_VERSION = 1;
const SSKR_PREFIX = "sskr:";

function fletcher16(data: Uint8Array): [number, number] {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 255;
    s2 = (s2 + s1) % 255;
  }
  return [s1, s2];
}

function toBase64Url(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const bin = atob(b);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface Shard {
  version: number;
  threshold: number;
  total: number;
  index: number;
  data: Uint8Array;
}

export function encodeShard(shard: Shard): string {
  const header = new Uint8Array([
    shard.version,
    shard.threshold,
    shard.total,
    shard.index,
  ]);
  const body = new Uint8Array(header.length + shard.data.length);
  body.set(header);
  body.set(shard.data, header.length);
  const [c1, c2] = fletcher16(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body);
  full[body.length] = c1;
  full[body.length + 1] = c2;
  return SSKR_PREFIX + toBase64Url(full);
}

export function decodeShard(encoded: string): Shard {
  const trimmed = encoded.trim();
  if (!trimmed.startsWith(SSKR_PREFIX))
    throw new Error(
      "Invalid format: shard must start with 'sskr:'",
    );

  const bytes = fromBase64Url(trimmed.slice(SSKR_PREFIX.length));
  if (bytes.length < 6) throw new Error("Shard too short");

  const body = bytes.subarray(0, bytes.length - 2);
  const [c1, c2] = fletcher16(body);
  if (bytes[bytes.length - 2] !== c1 || bytes[bytes.length - 1] !== c2)
    throw new Error("Checksum mismatch -- shard may be corrupted");

  if (body[0] !== SSKR_VERSION)
    throw new Error(`Unsupported SSKR version: ${body[0]}`);

  return {
    version: body[0],
    threshold: body[1],
    total: body[2],
    index: body[3],
    data: body.subarray(4),
  };
}

// ---- Public API -----------------------------------------------------------

/**
 * Splits a base64url key into N SSKR shards.
 */
export function splitKey(
  encodedKey: string,
  threshold: number,
  total: number,
): string[] {
  const keyBytes = fromBase64Url(encodedKey);
  const shares = shamirSplit(keyBytes, threshold, total);

  return shares.map((data, i) =>
    encodeShard({
      version: SSKR_VERSION,
      threshold,
      total,
      index: i + 1,
      data,
    }),
  );
}

/**
 * Reconstructs a base64url key from SSKR shards.
 */
export function combineShards(shardStrings: string[]): string {
  const shards = shardStrings.map(decodeShard);

  const t = shards[0].threshold;
  const total = shards[0].total;
  for (const s of shards) {
    if (s.threshold !== t || s.total !== total)
      throw new Error("Shards come from different sets");
  }

  if (shards.length < t)
    throw new Error(
      `${t} fragments required, only ${shards.length} provided`,
    );

  const indices = shards.map((s) => s.index);
  if (new Set(indices).size !== indices.length)
    throw new Error("Duplicate shards detected");

  const used = shards.slice(0, t);
  const recovered = shamirCombine(
    used.map((s) => s.index),
    used.map((s) => s.data),
  );
  return toBase64Url(recovered);
}
