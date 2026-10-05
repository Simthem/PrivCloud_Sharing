import { BadRequestException } from "@nestjs/common";

/** SHARES_ONLY excludes file request and submission notifications. */
export const wantsFileRequestNotification = (mode: string): boolean =>
  mode === "EVERY_FILE";

export function validateFileRequestEnvelope(value: string | undefined) {
  try {
    if (!value || value.length > 20000) throw new Error();
    const envelope = JSON.parse(value);
    const expectedKeys = [
      "algorithm",
      "ciphertext",
      "ephemeralPublicKey",
      "kemCiphertext",
      "nonce",
    ];
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(",") !== expectedKeys.join(",")
    )
      throw new Error();
    const bytes = (field: unknown) => {
      if (typeof field !== "string" || !/^[A-Za-z0-9_-]+$/.test(field))
        throw new Error();
      const data = Buffer.from(field, "base64url");
      if (data.toString("base64url") !== field) throw new Error();
      return data.length;
    };
    if (
      bytes(envelope.ephemeralPublicKey) !== 32 ||
      bytes(envelope.nonce) !== 12 ||
      bytes(envelope.ciphertext) < 17
    )
      throw new Error();
    if (envelope.algorithm === "x25519-mlkem768-aes256gcm") {
      if (bytes(envelope.kemCiphertext) !== 1088) throw new Error();
    } else if (
      envelope.algorithm !== "x25519-aes256gcm" ||
      envelope.kemCiphertext !== null
    )
      throw new Error();
    return value;
  } catch {
    throw new BadRequestException(
      "A valid encrypted notification envelope is required",
    );
  }
}
