/** Decode bounded text prefixes, including BOM-marked UTF-16 and legacy text. */
export function decodePreviewText(bytes: Uint8Array, partial = false): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes, { stream: partial });
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes, { stream: partial });
  try {
    // A byte-range boundary can cut the final UTF-8 character. Keep its prefix.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: partial,
    });
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
