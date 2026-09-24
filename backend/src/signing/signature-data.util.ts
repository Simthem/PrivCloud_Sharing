/**
 * Signature data is a PNG or JPEG data URL (drawn, typed and uploaded
 * signatures are all rasterized by the signing pad), or plain text for a typed
 * signature sent through the API. The format is taken from the bytes, never
 * from the declared type, so a finalization never meets data it cannot draw.
 * The same file exists in the frontend for the E2E finalization.
 */

export type SignatureVisual =
  | { kind: "image"; format: "png" | "jpg"; bytes: Uint8Array }
  | { kind: "text"; text: string };

export const MAX_TYPED_SIGNATURE_LENGTH = 120;

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

const decodeBase64 = (value: string): Uint8Array => {
  if (typeof atob === "function") {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(value, "base64"));
};

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

export function parseSignatureData(
  signatureData: string,
  signatureType: string | null | undefined,
): SignatureVisual {
  const dataUrl = signatureData.match(DATA_URL);
  if (dataUrl) {
    const bytes = decodeBase64(dataUrl[2]);
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return { kind: "image", format: "png", bytes };
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
      return { kind: "image", format: "jpg", bytes };
    }
    throw new Error("The signature image must be a PNG or JPEG image");
  }
  if (signatureData.startsWith("data:")) {
    throw new Error("The signature image is not a valid base64 data URL");
  }
  const text = signatureData.trim();
  if (
    signatureType !== "TYPE" ||
    text.length === 0 ||
    text.length > MAX_TYPED_SIGNATURE_LENGTH
  ) {
    throw new Error("The signature data is not a usable signature");
  }
  return { kind: "text", text };
}
