import * as https from "node:https";
import { createHttpsProxyAgent } from "../utils/https-proxy-agent.util";

// Keep the existing signing API while sharing the verified HTTPS proxy route.
export { createHttpsProxyAgent as createTrustedListAgent } from "../utils/https-proxy-agent.util";

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
    const agent = createHttpsProxyAgent(url, process.env, controller.signal);
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
