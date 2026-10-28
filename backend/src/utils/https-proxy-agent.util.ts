import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import { HttpsProxyAgent } from "https-proxy-agent";

function bypassesProxy(url: URL, exclusions: string): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return exclusions.split(",").some((entry) => {
    let pattern = entry.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.includes("/")) {
      const [address, prefix] = pattern.split("/");
      const family = isIP(address);
      if (!family || !isIP(hostname) || !/^\d+$/.test(prefix || ""))
        return false;
      try {
        const block = new BlockList();
        block.addSubnet(
          address,
          Number(prefix),
          family === 6 ? "ipv6" : "ipv4",
        );
        return block.check(hostname, isIP(hostname) === 6 ? "ipv6" : "ipv4");
      } catch {
        return false;
      }
    }
    const withPort = pattern.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (withPort) {
      if (withPort[2] !== (url.port || "443")) return false;
      pattern = withPort[1];
    }
    pattern = pattern.replace(/^\[|\]$/g, "");
    if (pattern.startsWith(".")) {
      return hostname === pattern.slice(1) || hostname.endsWith(pattern);
    }
    const expression = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${expression}$`).test(hostname);
  });
}

export function createHttpsProxyAgent(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
) {
  const exclusions = [env.GLOBAL_AGENT_NO_PROXY, env.NO_PROXY, env.no_proxy]
    .filter(Boolean)
    .join(",");
  const proxy =
    env.GLOBAL_AGENT_HTTPS_PROXY ||
    env.GLOBAL_AGENT_HTTP_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy;
  // Always supply an agent: the explicit route must not fall back to the native
  // environment proxy or global-agent's TLS tunnel implementation.
  return proxy && !bypassesProxy(url, exclusions)
    ? new HttpsProxyAgent(proxy, { signal })
    : new https.Agent();
}
