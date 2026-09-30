import shareService from "../services/share.service";
import {
  ShareCryptoSchemeName,
  describeCryptoClient,
  shareCryptoSchemeName,
} from "./shareKey.util";

export type ShareCryptoEvent =
  | "dek_create_error"
  | "unwrap_error"
  | "decrypt_error"
  | "download_error"
  | "rewrap_ok"
  | "rewrap_error";

/**
 * Count a client-side crypto outcome on the server. Only the event, the
 * scheme and the client version are sent: never a share id, a key, the link
 * fragment or file data. Best effort, never throws.
 */
export function reportShareCryptoEvent(
  event: ShareCryptoEvent,
  scheme: number | null | undefined | ShareCryptoSchemeName,
): void {
  let schemeName: ShareCryptoSchemeName;
  try {
    schemeName =
      typeof scheme === "string" ? scheme : shareCryptoSchemeName(scheme);
  } catch {
    return;
  }
  void shareService
    .reportCryptoEvent({ event, scheme: schemeName, ...describeCryptoClient() })
    .catch(() => undefined);
}

/** Count a failed E2E download as a decryption or a transfer failure. */
export function reportE2EDownloadFailure(
  error: unknown,
  scheme: number | null | undefined,
): void {
  const { name, message } = (error ?? {}) as {
    name?: string;
    message?: string;
  };
  if (name === "AbortError") return;
  reportShareCryptoEvent(
    name === "OperationError" || /decrypt/i.test(message ?? "")
      ? "decrypt_error"
      : "download_error",
    scheme,
  );
}
