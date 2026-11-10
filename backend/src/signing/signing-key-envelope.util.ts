import { BadRequestException } from "@nestjs/common";

export function assertSigningKeyEnvelope(value: string) {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    envelope = parsed as Record<string, unknown>;
  } catch {
    throw new BadRequestException("Invalid encrypted signing key envelope");
  }
  const base64 = (value: unknown, length?: number) =>
    typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    (length === undefined
      ? value.length >= 22 && value.length <= 45000
      : value.length === length);
  const hybrid = envelope.algorithm === "x25519-mlkem768-aes256gcm";
  if (
    (!hybrid && envelope.algorithm !== "x25519-aes256gcm") ||
    !base64(envelope.ciphertext) ||
    !base64(envelope.ephemeralPublicKey, 43) ||
    !base64(envelope.nonce, 16) ||
    (hybrid
      ? !base64(envelope.kemCiphertext, 1451)
      : envelope.kemCiphertext !== null) ||
    Object.keys(envelope).some(
      (key) =>
        ![
          "algorithm",
          "ciphertext",
          "ephemeralPublicKey",
          "nonce",
          "kemCiphertext",
        ].includes(key),
    )
  ) {
    throw new BadRequestException("Invalid encrypted signing key envelope");
  }
}
