/**
 * ML-KEM notification encryption is a Team-level opt-in. A member without a
 * registered PQ public key must retain the compatible X25519-only envelope.
 */
export const selectPqNotificationPublicKey = (
  teamOptedIn: boolean,
  publicKey?: string | null,
): string | null => (teamOptedIn && publicKey ? publicKey : null);
