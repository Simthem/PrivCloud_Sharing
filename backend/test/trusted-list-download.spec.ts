import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as https from "node:https";
import { connect, createServer, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createTrustedListAgent } from "src/signing/trusted-list-download.util";
import { createTestCertificate } from "./signing-certificate.fixture";

const backendDirectory = path.resolve(__dirname, "..");
const backendModules = path.join(backendDirectory, "node_modules");
const tsNodeRegister = require.resolve("ts-node/register");

test("Trusted List transport selects the proxy and honors scoped NO_PROXY entries", () => {
  for (const key of [
    "GLOBAL_AGENT_HTTPS_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ]) {
    const agent = createTrustedListAgent(
      new URL("https://list.example.test/list.xml"),
      { [key]: "http://127.0.0.1:3128" },
    );
    assert.ok(agent instanceof HttpsProxyAgent, key);
    agent.destroy();
  }
  for (const [target, exclusion, direct] of [
    ["https://list.example.test", "localhost", false],
    ["https://list.example.test", "list.example.test", true],
    ["https://list.example.test", ".example.test", true],
    ["https://list.example.test", "*.example.test", true],
    ["https://list.example.test", "list.example.test:443", true],
    ["https://list.example.test", "list.example.test:444", false],
    ["https://list.example.test", "*", true],
    ["https://10.142.80.80", "10.142.0.0/16", true],
    ["https://10.143.80.80", "10.142.0.0/16", false],
    ["https://[::1]", "[::1]:443", true],
    ["https://list.example.test", "listXexample.test", false],
  ] as const) {
    for (const key of ["GLOBAL_AGENT_NO_PROXY", "NO_PROXY", "no_proxy"]) {
      const agent = createTrustedListAgent(new URL(target), {
        HTTPS_PROXY: "http://127.0.0.1:3128",
        [key]: exclusion,
      });
      assert.equal(agent instanceof https.Agent, direct, `${key}=${exclusion}`);
      agent.destroy();
    }
  }
  const agent = createTrustedListAgent(
    new URL("https://list.example.test"),
    {},
  );
  assert.ok(agent instanceof https.Agent);
  agent.destroy();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("Trusted List downloads use verified TLS through fragmented CONNECT replies, without direct fallback", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "privcloud-trusted-list-"));
  const certificate = createTestCertificate({ commonName: "localhost" });
  const certificatePath = path.join(directory, "ca.pem");
  writeFileSync(certificatePath, certificate.pem);
  // Keep the preload outside the checkout so ancestor node_modules cannot
  // hide a missing backend dependency path, as happened locally versus CI.
  const bootstrapPath = path.join(directory, "bootstrap.cjs");
  writeFileSync(
    bootstrapPath,
    readFileSync(path.join(backendDirectory, "../global-agent-bootstrap.js")),
  );
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  };
  let requests = 0;
  let tunnels = 0;
  let mode = "tunnel";
  const origin = https.createServer(
    {
      key: certificate.privateKey.export({ type: "pkcs8", format: "pem" }),
      cert: certificate.pem,
    },
    (request, response) => {
      requests++;
      if (request.url === "/missing") {
        response.writeHead(404).end();
      } else if (request.url === "/large") {
        response.end(Buffer.alloc(128));
      } else {
        response.end("<TrustedList/>");
      }
    },
  );
  origin.on("connection", track);
  const proxy = createServer((client) => {
    track(client);
    let preamble = "";
    const read = (chunk: Buffer) => {
      preamble += chunk.toString("ascii");
      if (!preamble.includes("\r\n\r\n")) return;
      client.removeListener("data", read);
      tunnels++;
      if (mode === "stall") return;
      if (mode === "deny") {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(originPort, "127.0.0.1", () => {
        // Split the CONNECT headers across TCP reads: TLS must wait for all
        // headers, rather than treating the first read as a complete reply.
        client.write("HTTP/1.1 200 Connection established\r\n");
        setTimeout(() => {
          client.write("Proxy-Agent: fixture\r\n\r\n");
          client.pipe(upstream);
          upstream.pipe(client);
        }, 20);
      });
      track(upstream);
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    };
    client.on("data", read);
  });
  let originPort = 0;
  try {
    originPort = await listen(origin);
    const proxyPort = await listen(proxy);
    const run = (
      pathname: string,
      expected: string,
      trusted = true,
      noProxy = "",
    ) =>
      new Promise<void>((resolve, reject) => {
        const env = {
          ...process.env,
          NODE_OPTIONS: `--require ${JSON.stringify(bootstrapPath)}`,
          NODE_PATH: [backendDirectory, backendModules].join(path.delimiter),
          NODE_USE_ENV_PROXY: "1",
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          NODE_EXTRA_CA_CERTS: certificatePath,
          GLOBAL_AGENT_FORCE_GLOBAL_AGENT: "false",
          GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          GLOBAL_AGENT_NO_PROXY: noProxy,
          NO_PROXY: "",
          no_proxy: "",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          http_proxy: "http://127.0.0.1:1",
          https_proxy: "http://127.0.0.1:1",
        };
        if (!trusted) delete env.NODE_EXTRA_CA_CERTS;
        const child = spawn(
          process.execPath,
          [
            "-r",
            tsNodeRegister,
            "-e",
            `
        const assert = require('node:assert/strict');
        assert.ok(global.GLOBAL_AGENT, 'The isolated proxy preload must initialize');
        assert.equal(require.resolve('global-agent'), ${JSON.stringify(require.resolve("global-agent"))});
        const { downloadTrustedList } = require('./src/signing/trusted-list-download.util');
        (async () => {
          const expected = ${JSON.stringify(expected)};
          try {
            const result = await downloadTrustedList(${JSON.stringify(`https://localhost:${originPort}${pathname}`)}, { timeoutMs: 1500, maxBytes: 64 });
            if (expected !== 'OK') assert.fail('The failing fixture unexpectedly downloaded successfully');
            assert.equal(result.toString(), '<TrustedList/>');
          } catch (error) {
            if (expected === 'OK') throw error;
            assert.ok((String(error.code) + ' ' + error.message).includes(expected), error.message);
          }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `,
          ],
          { cwd: backendDirectory, env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const deadline = setTimeout(() => child.kill(), 12000);
        child.once("error", reject);
        child.once("exit", (code) => {
          clearTimeout(deadline);
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Trusted List probe failed (${pathname}, ${expected}): ${output}`,
              ),
            );
        });
      });
    await run("/list", "OK");
    assert.equal(tunnels, 1);
    await run("/list", "OK", true, "localhost");
    assert.equal(tunnels, 1, "NO_PROXY must bypass both proxy implementations");
    await run("/list", "DEPTH_ZERO_SELF_SIGNED_CERT", false);
    await run("/missing", "HTTP 404");
    await run("/large", "too large");
    const beforeDenial = requests;
    mode = "deny";
    await run("/list", "HTTP 403");
    assert.equal(
      requests,
      beforeDenial,
      "a denied proxy must never trigger a direct retry",
    );
    mode = "stall";
    await run("/list", "timed out");
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [origin, proxy].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});
