/** Expiration is an instant, including its boundary. Epoch zero means never. */
export function isShareExpired(expiration: Date, now = new Date()): boolean {
  const timestamp = expiration.getTime();
  return timestamp !== 0 && timestamp <= now.getTime();
}
