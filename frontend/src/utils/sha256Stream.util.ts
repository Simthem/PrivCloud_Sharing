import {
  PREVIEW_READ_BYTES,
  type PreviewByteSource,
} from "./previewRange.util";

// Incremental SHA-256 (FIPS 180-4). WebCrypto only hashes a whole buffer,
// and the original behind a copy for a contractor may be far larger than
// what a page should hold in memory.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private block = new Uint8Array(64);
  private filled = 0;
  private length = 0;
  private words = new Uint32Array(64);

  update(data: Uint8Array) {
    this.length += data.length;
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(64 - this.filled, data.length - offset);
      this.block.set(data.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === 64) {
        this.compress();
        this.filled = 0;
      }
    }
    return this;
  }

  private compress() {
    const w = this.words;
    const b = this.block;
    for (let i = 0; i < 16; i++) {
      w[i] =
        (b[i * 4] << 24) |
        (b[i * 4 + 1] << 16) |
        (b[i * 4 + 2] << 8) |
        b[i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i++) {
      const s1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[i] + w[i]) | 0;
      const s0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const majority = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    const s = this.state;
    s[0] += a;
    s[1] += bb;
    s[2] += c;
    s[3] += d;
    s[4] += e;
    s[5] += f;
    s[6] += g;
    s[7] += h;
  }

  digestHex(): string {
    const bits = this.length * 8;
    const padding = new Uint8Array(
      (this.filled < 56 ? 56 : 120) - this.filled + 8,
    );
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(padding.length - 4, bits >>> 0);
    const total = this.length;
    this.update(padding);
    this.length = total;
    return Array.from(this.state, (word) =>
      word.toString(16).padStart(8, "0"),
    ).join("");
  }
}

/** SHA-256 of the whole decrypted original, read in chunks. */
export async function hashPreviewSource(
  source: PreviewByteSource,
  signal?: AbortSignal,
): Promise<string> {
  const hash = new Sha256();
  for (let start = 0; start < source.size; start += PREVIEW_READ_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(source.size, start + PREVIEW_READ_BYTES);
    hash.update(await source.read(start, end, signal));
  }
  return hash.digestHex();
}

/** SHA-256 of a buffer, lowercase hex. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
