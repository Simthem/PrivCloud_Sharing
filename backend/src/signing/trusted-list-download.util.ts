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

export function createTrustedListAgent(
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

export function downloadTrustedList(
  listUrl: string,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url = new URL(listUrl);
    if (url.protocol !== "https:") {
      reject(new Error("The Trusted List URL must use HTTPS"));
      return;
    }
    const timeoutMs = limits.timeoutMs ?? 60_000;
    const maxBytes = limits.maxBytes ?? 50 * 1024 * 1024;
    const controller = new AbortController();
    const agent = createTrustedListAgent(url, process.env, controller.signal);
    let settled = false;
    const finish = (error?: Error, buffer?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      agent.destroy();
      if (error) reject(error);
      else resolve(buffer!);
    };
    const request = https.get(
      url,
      {
        agent,
        signal: controller.signal,
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          finish(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            const error = new Error("The Trusted List is too large");
            finish(error);
            request.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish(undefined, Buffer.concat(chunks)));
        response.on("error", (error) => finish(error));
      },
    );
    const onTimeout = () => {
      request.destroy(new Error("Trusted List download timed out"));
      finish(new Error("Trusted List download timed out"));
    };
    // Include a stalled CONNECT/TLS handshake in the deadline, not only an
    // established socket's inactivity timeout.
    const timer = setTimeout(onTimeout, timeoutMs);
    request.on("timeout", onTimeout);
    request.on("error", (error) => finish(error));
  });
}
