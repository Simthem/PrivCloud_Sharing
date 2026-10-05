import { X509Certificate } from "crypto";

/**
 * Minimal ASN.1 codec for the structures the signing service builds and reads
 * (CMS SignedData, RFC 3161 messages, PKCS#12 and X.509 certificates).
 * Encoding is always DER. Decoding also accepts the BER indefinite lengths a
 * TSA may return, within explicit bounds. No cryptographic decision is taken
 * here: signatures, digests and keys stay with node:crypto (OpenSSL).
 */

export const Asn1Class = {
  UNIVERSAL: 0x00,
  APPLICATION: 0x40,
  CONTEXT_SPECIFIC: 0x80,
  PRIVATE: 0xc0,
} as const;

export const Asn1Type = {
  BOOLEAN: 1,
  INTEGER: 2,
  BITSTRING: 3,
  OCTETSTRING: 4,
  NULL: 5,
  OID: 6,
  UTF8: 12,
  SEQUENCE: 16,
  SET: 17,
  PRINTABLESTRING: 19,
  T61STRING: 20,
  IA5STRING: 22,
  UTCTIME: 23,
  GENERALIZEDTIME: 24,
  BMPSTRING: 30,
} as const;

export type Asn1Node = {
  tagClass: number;
  type: number;
  constructed: boolean;
  value: Buffer | Asn1Node[];
};

const MAX_DEPTH = 64;

export const asn1 = {
  create(
    tagClass: number,
    type: number,
    constructed: boolean,
    value: Buffer | Asn1Node[],
  ): Asn1Node {
    return { tagClass, type, constructed, value };
  },
  sequence(children: Asn1Node[]): Asn1Node {
    return asn1.create(Asn1Class.UNIVERSAL, Asn1Type.SEQUENCE, true, children);
  },
  set(children: Asn1Node[]): Asn1Node {
    return asn1.create(Asn1Class.UNIVERSAL, Asn1Type.SET, true, children);
  },
  /** Constructed context-specific tag, e.g. [0] EXPLICIT or [0] IMPLICIT SET. */
  context(tag: number, children: Asn1Node[]): Asn1Node {
    return asn1.create(Asn1Class.CONTEXT_SPECIFIC, tag, true, children);
  },
  oid(dotted: string): Asn1Node {
    return asn1.create(
      Asn1Class.UNIVERSAL,
      Asn1Type.OID,
      false,
      oidToDer(dotted),
    );
  },
  null(): Asn1Node {
    return asn1.create(
      Asn1Class.UNIVERSAL,
      Asn1Type.NULL,
      false,
      Buffer.alloc(0),
    );
  },
  boolean(value: boolean): Asn1Node {
    return asn1.create(
      Asn1Class.UNIVERSAL,
      Asn1Type.BOOLEAN,
      false,
      Buffer.from([value ? 0xff : 0x00]),
    );
  },
  octetString(value: Buffer): Asn1Node {
    return asn1.create(Asn1Class.UNIVERSAL, Asn1Type.OCTETSTRING, false, value);
  },
  /** A non-negative number, or the raw two's complement content bytes. */
  integer(value: number | Buffer): Asn1Node {
    return asn1.create(
      Asn1Class.UNIVERSAL,
      Asn1Type.INTEGER,
      false,
      Buffer.isBuffer(value) ? value : unsignedIntegerToDer(value),
    );
  },
  utcTime(date: Date): Asn1Node {
    const pad = (value: number) => value.toString().padStart(2, "0");
    const text =
      pad(date.getUTCFullYear() % 100) +
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds()) +
      "Z";
    return asn1.create(
      Asn1Class.UNIVERSAL,
      Asn1Type.UTCTIME,
      false,
      Buffer.from(text, "latin1"),
    );
  },
  /** AlgorithmIdentifier with NULL parameters. */
  algorithm(oid: string): Asn1Node {
    return asn1.sequence([asn1.oid(oid), asn1.null()]);
  },
};

function unsignedIntegerToDer(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("ASN.1 INTEGER builder only accepts non-negative integers");
  }
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

export function oidToDer(dotted: string): Buffer {
  if (!/^[0-2]\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/.test(dotted)) {
    throw new Error(`Invalid OID: ${dotted}`);
  }
  const arcs = dotted.split(".").map((arc) => BigInt(arc));
  if (arcs[0] < 2n && arcs[1] > 39n) throw new Error(`Invalid OID: ${dotted}`);
  const bytes: number[] = [];
  const encodeArc = (arc: bigint) => {
    const chunk = [Number(arc & 0x7fn)];
    for (let rest = arc >> 7n; rest > 0n; rest >>= 7n) {
      chunk.unshift(Number(rest & 0x7fn) | 0x80);
    }
    bytes.push(...chunk);
  };
  encodeArc(arcs[0] * 40n + arcs[1]);
  arcs.slice(2).forEach(encodeArc);
  return Buffer.from(bytes);
}

export function oidFromDer(bytes: Buffer): string {
  if (bytes.length === 0 || bytes[bytes.length - 1] & 0x80) {
    throw new Error("Invalid OID encoding");
  }
  const arcs: bigint[] = [];
  let arc = 0n;
  for (const byte of bytes) {
    if (arc === 0n && byte === 0x80) throw new Error("Invalid OID encoding");
    arc = (arc << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(arc);
      arc = 0n;
    }
  }
  const first = arcs[0] < 80n ? arcs[0] / 40n : 2n;
  return [first, arcs[0] - first * 40n, ...arcs.slice(1)].join(".");
}

export function encodeDer(node: Asn1Node): Buffer {
  const content = Array.isArray(node.value)
    ? Buffer.concat(node.value.map(encodeDer))
    : node.value;
  const constructedBit = node.constructed ? 0x20 : 0;
  let identifier: Buffer;
  if (node.type < 31) {
    identifier = Buffer.from([node.tagClass | constructedBit | node.type]);
  } else {
    const tag = [node.type & 0x7f];
    for (let rest = node.type >>> 7; rest > 0; rest >>>= 7) {
      tag.unshift((rest & 0x7f) | 0x80);
    }
    identifier = Buffer.from([node.tagClass | constructedBit | 0x1f, ...tag]);
  }
  return Buffer.concat([identifier, encodeLength(content.length), content]);
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Decode exactly one ASN.1 value and reject any trailing byte. */
export function parseDer(bytes: Buffer): Asn1Node {
  const { node, length } = parseDerPrefix(bytes);
  if (length !== bytes.length) {
    throw new Error("Unparsed bytes remain after the ASN.1 value");
  }
  return node;
}

/** Decode the ASN.1 value at the start of bytes (e.g. a padded /Contents). */
export function parseDerPrefix(bytes: Buffer): {
  node: Asn1Node;
  length: number;
} {
  const { node, end } = readNode(bytes, 0, bytes.length, 0);
  return { node, length: end };
}

function readNode(
  bytes: Buffer,
  start: number,
  limit: number,
  depth: number,
): { node: Asn1Node; end: number } {
  if (depth > MAX_DEPTH) throw new Error("ASN.1 nesting is too deep");
  let offset = start;
  const take = () => {
    if (offset >= limit) throw new Error("Truncated ASN.1 value");
    return bytes[offset++];
  };

  const identifier = take();
  const tagClass = identifier & 0xc0;
  const constructed = (identifier & 0x20) !== 0;
  let type = identifier & 0x1f;
  if (type === 0x1f) {
    type = 0;
    let byte: number;
    do {
      byte = take();
      type = type * 128 + (byte & 0x7f);
      if (type > 0x1fffff) throw new Error("ASN.1 tag number is too large");
    } while (byte & 0x80);
  }

  const lengthByte = take();
  if (lengthByte === 0x80) {
    if (!constructed) {
      throw new Error("Indefinite length on a primitive ASN.1 value");
    }
    const children: Asn1Node[] = [];
    for (;;) {
      if (offset + 2 > limit) throw new Error("Truncated ASN.1 value");
      if (bytes[offset] === 0 && bytes[offset + 1] === 0) {
        offset += 2;
        break;
      }
      const child = readNode(bytes, offset, limit, depth + 1);
      children.push(child.node);
      offset = child.end;
    }
    return {
      node: { tagClass, type, constructed, value: children },
      end: offset,
    };
  }

  let length = lengthByte;
  if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f;
    if (count > 4) throw new Error("ASN.1 length is too large");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + take();
  }
  const end = offset + length;
  if (end > limit) throw new Error("Truncated ASN.1 value");

  if (!constructed) {
    const value = Buffer.from(bytes.subarray(offset, end));
    return { node: { tagClass, type, constructed, value }, end };
  }
  const children: Asn1Node[] = [];
  while (offset < end) {
    const child = readNode(bytes, offset, end, depth + 1);
    children.push(child.node);
    offset = child.end;
  }
  return { node: { tagClass, type, constructed, value: children }, end };
}

export function children(node: Asn1Node | undefined): Asn1Node[] {
  return node && Array.isArray(node.value) ? node.value : [];
}

export function isUniversal(node: Asn1Node | undefined, type: number) {
  return node?.tagClass === Asn1Class.UNIVERSAL && node.type === type;
}

export function isContext(node: Asn1Node | undefined, tag: number) {
  return node?.tagClass === Asn1Class.CONTEXT_SPECIFIC && node.type === tag;
}

/** OID string of an OID node, or "" for anything else. */
export function readOid(node: Asn1Node | undefined): string {
  if (!isUniversal(node, Asn1Type.OID) || !Buffer.isBuffer(node.value)) {
    return "";
  }
  return oidFromDer(node.value);
}

/** Content bytes, joining the segments of a BER constructed string. */
export function readOctets(node: Asn1Node | undefined): Buffer {
  if (!node) return Buffer.alloc(0);
  if (Buffer.isBuffer(node.value)) return node.value;
  return Buffer.concat(node.value.map(readOctets));
}

/** Small non-negative INTEGER (versions, statuses, iteration counts). */
export function readSmallInteger(node: Asn1Node | undefined): number {
  const bytes = readOctets(node);
  if (bytes.length === 0 || bytes.length > 6 || bytes[0] & 0x80) {
    throw new Error("Unsupported ASN.1 INTEGER value");
  }
  return bytes.readUIntBE(0, bytes.length);
}

/** UTCTime or GeneralizedTime as a Date (Z suffix required, as in DER). */
export function readTime(node: Asn1Node | undefined): Date {
  const text = readOctets(node).toString("latin1");
  let match: RegExpMatchArray | null = null;
  let year = 0;
  if (isUniversal(node, Asn1Type.UTCTIME)) {
    match = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (match) {
      const short = Number(match[1]);
      year = short >= 50 ? 1900 + short : 2000 + short;
    }
  } else if (isUniversal(node, Asn1Type.GENERALIZEDTIME)) {
    match = text.match(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{1,9})?Z$/,
    );
    if (match) year = Number(match[1]);
  }
  if (!match) throw new Error("Invalid ASN.1 time value");
  const milliseconds = match[7] ? Math.floor(Number(`0${match[7]}`) * 1000) : 0;
  return new Date(
    Date.UTC(
      year,
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      milliseconds,
    ),
  );
}

export type CertificateExtension = {
  oid: string;
  critical: boolean;
  value: Buffer;
};

/** Fields of an X.509 certificate needed for CMS and RFC 3161 checks. */
export type ParsedCertificate = {
  der: Buffer;
  x509: X509Certificate;
  /** Raw INTEGER content of the serial number, sign byte included. */
  serial: Buffer;
  issuer: Asn1Node;
  issuerDer: Buffer;
  subjectDer: Buffer;
  notBefore: Date;
  notAfter: Date;
  extensions: CertificateExtension[];
};

export function parseCertificate(der: Buffer): ParsedCertificate {
  const x509 = new X509Certificate(der);
  const certificate = parseDer(der);
  const tbs = children(certificate)[0];
  const fields = children(tbs);
  const offset = isContext(fields[0], 0) ? 1 : 0;
  const serialNode = fields[offset];
  const issuer = fields[offset + 2];
  const validity = children(fields[offset + 3]);
  const subject = fields[offset + 4];
  if (
    !isUniversal(serialNode, Asn1Type.INTEGER) ||
    !isUniversal(issuer, Asn1Type.SEQUENCE) ||
    !isUniversal(subject, Asn1Type.SEQUENCE) ||
    validity.length !== 2
  ) {
    throw new Error("Invalid X.509 certificate structure");
  }

  const extensions = children(
    children(fields.slice(offset + 6).find((node) => isContext(node, 3)))[0],
  ).map((extension) => {
    const parts = children(extension);
    const critical = isUniversal(parts[1], Asn1Type.BOOLEAN);
    return {
      oid: readOid(parts[0]),
      critical: critical && readOctets(parts[1])[0] !== 0,
      value: readOctets(parts[critical ? 2 : 1]),
    };
  });

  return {
    der,
    x509,
    serial: readOctets(serialNode),
    issuer,
    issuerDer: encodeDer(issuer),
    subjectDer: encodeDer(subject),
    notBefore: readTime(validity[0]),
    notAfter: readTime(validity[1]),
    extensions,
  };
}
