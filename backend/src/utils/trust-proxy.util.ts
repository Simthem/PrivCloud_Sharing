// Which hops Express may skip in X-Forwarded-For to find the client address.
// Caddy runs in the container, so a hop count of 1 would stop at whatever
// reaches Caddy (HAProxy, the Docker gateway) and give every client the same
// address. Behind TRUST_PROXY the private hops are skipped instead, a public
// client address cannot be forged by prepending entries.
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.TRUSTED_PROXIES?.trim();
  if (explicit) {
    if (/^\d+$/.test(explicit)) {
      const hops = Number(explicit);
      if (Number.isSafeInteger(hops)) return hops;
    }
    return explicit;
  }
  return env.TRUST_PROXY === "true"
    ? "loopback, linklocal, uniquelocal"
    : "loopback";
}
