import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import {
  connect,
  createServer as createTunnelServer,
  Server,
  Socket,
} from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repository = path.resolve(__dirname, "../..");
const backendModules = path.resolve(__dirname, "../node_modules");

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

for (const dockerfile of ["Dockerfile", "Dockerfile.full-build"]) {
  test(`${dockerfile} proxy preload works with only its copied dependencies`, async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "privcloud proxy security-"),
    );
    let direct: Server | undefined;
    let proxy: Server | undefined;
    let tunnels = 0;
    const sockets = new Set<Socket>();
    const trackSocket = (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    try {
      const certificate = path.join(directory, "cert.pem");
      const privateKey = path.join(directory, "key.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          privateKey,
          "-out",
          certificate,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:proxy-fixture.invalid",
        ],
        { stdio: "ignore" },
      );
      direct = createServer(
        {
          key: readFileSync(privateKey),
          cert: readFileSync(certificate),
          minVersion: "TLSv1.2",
        },
        (request, response) =>
          response.end(request.url === "/via-proxy" ? "proxy" : "direct"),
      );
      const directPort = await listen(direct);
      direct.on("connection", trackSocket);

      // global-agent uses an HTTP CONNECT proxy. Only its loopback handshake
      // is plaintext. Every tested request and response stays inside verified TLS.
      proxy = createTunnelServer((client) => {
        let preamble = "";
        const readConnect = (chunk: Buffer) => {
          preamble += chunk.toString("ascii");
          if (preamble.length > 8192) {
            client.destroy();
            return;
          }
          if (!preamble.endsWith("\r\n\r\n")) return;
          client.removeListener("data", readConnect);
          if (
            !preamble.startsWith(
              `CONNECT proxy-fixture.invalid:${directPort} HTTP/1.1\r\n`,
            )
          ) {
            client.destroy();
            return;
          }
          tunnels++;
          client.pause();
          const upstream = connect(directPort, "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
          });
          upstream.on("error", () => client.destroy());
          client.on("close", () => upstream.destroy());
        };
        client.on("error", () => client.destroy());
        client.on("data", readConnect);
      });
      const proxyPort = await listen(proxy);
      proxy.on("connection", trackSocket);
      const source = readFileSync(path.join(repository, dockerfile), "utf8");
      const copied = [
        ...source.matchAll(
          /^COPY[^\n]*--from=backend-deps \/opt\/app\/backend\/node_modules\/(\S+) \.\/node_modules\/\S+$/gm,
        ),
      ];
      assert.ok(copied.length > 0);
      for (const [, name] of copied) {
        cpSync(
          path.join(backendModules, name),
          path.join(directory, "node_modules", name),
          { recursive: true },
        );
      }
      cpSync(
        path.join(repository, "global-agent-bootstrap.js"),
        path.join(directory, "global-agent-bootstrap.js"),
      );
      assert.match(
        source,
        /^COPY[^\n]* \.\/global-agent-bootstrap\.js \.\/global-agent-bootstrap\.js$/m,
      );
      for (const name of ["entrypoint.mjs", "backend-node-options.cjs"]) {
        assert.ok(
          source.includes(`./scripts/docker/${name} ./scripts/docker/${name}`),
          `${dockerfile} must copy ${name} into the runtime`,
        );
        cpSync(
          path.join(repository, "scripts", "docker", name),
          path.join(directory, "scripts", "docker", name),
          { recursive: true },
        );
      }
      writeFileSync(
        path.join(directory, "node-options.mjs"),
        `
        import { backendNodeOptions } from "./scripts/docker/entrypoint.mjs";
        const inherited = [
          "",
          "--trace-warnings --require ./node_modules/global-agent/bootstrap",
          "--dns-result-order=ipv4first --require=/opt/app/backend/node_modules/global-agent/bootstrap",
        ];
        process.stdout.write(JSON.stringify(inherited.map((NODE_OPTIONS) =>
          backendNodeOptions({ NODE_OPTIONS }, process.env.PRIVCLOUD_BACKEND_DIRECTORY)
        )));
        `,
      );
      const nodeOptions: string[] = JSON.parse(
        execFileSync(process.execPath, ["./node-options.mjs"], {
          cwd: directory,
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            NODE_PATH: "",
            PRIVCLOUD_BACKEND_DIRECTORY: directory,
          },
          encoding: "utf8",
        }),
      );
      writeFileSync(
        path.join(directory, "probe.cjs"),
        `
        const assert = require("node:assert/strict");
        const https = require("node:https");
        const get = (url, options = {}) => new Promise((resolve, reject) => {
          https.get(url, options, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => resolve(body));
          }).on("error", reject);
        });
        (async () => {
          assert.equal(await get("https://proxy-fixture.invalid:${directPort}/via-proxy"), "proxy");
          assert.equal(await get("https://localhost:${directPort}/bypass"), "direct");
          const explicit = new https.Agent({ keepAlive: true });
          try {
            assert.equal(await get("https://127.0.0.1:${directPort}/explicit", { agent: explicit }), "direct");
          } finally { explicit.destroy(); }
          console.log("proxy, NO_PROXY and explicit agents verified");
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      `,
      );
      for (const options of nodeOptions) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["./probe.cjs"], {
            cwd: directory,
            env: {
              ...process.env,
              NODE_USE_ENV_PROXY: "0",
              NODE_OPTIONS: options,
              NODE_PATH: "",
              NODE_EXTRA_CA_CERTS: certificate,
              GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
              GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
              GLOBAL_AGENT_NO_PROXY: "localhost",
              GLOBAL_AGENT_FORCE_GLOBAL_AGENT: "false",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          const timeout = setTimeout(() => child.kill(), 10_000);
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve();
            else reject(new Error(`Proxy preload failed: ${output}`));
          });
        });
      }
      assert.equal(
        tunnels,
        nodeOptions.length,
        "NO_PROXY and explicit agents must bypass the tunnel",
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [direct, proxy].map(
          (server) =>
            new Promise<void>((resolve) => {
              if (server) server.close(() => resolve());
              else resolve();
            }),
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
