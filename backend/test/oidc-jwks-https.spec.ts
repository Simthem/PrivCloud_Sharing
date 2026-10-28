import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as https from "node:https";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { GoogleProvider } from "src/oauth/provider/google.provider";
import { ErrorPageException } from "src/oauth/exceptions/errorPage.exception";

// All application and CONNECT traffic uses HTTPS, with throwaway CA trust.
// The proxy only forwards to this fixture's literal loopback address.
async function probe() {
  const mode = process.env.OIDC_FIXTURE_MODE!;
  const origin = process.env.OIDC_FIXTURE_ORIGIN!;
  const { fetch: proxyFetch, ProxyAgent } = await import("undici");
  const dispatcher =
    mode === "proxy" || mode === "bootstrap"
      ? new ProxyAgent(process.env.HTTPS_PROXY!)
      : undefined;
  const nativeFetch = globalThis.fetch;
  if (dispatcher)
    globalThis.fetch = ((
      input: Parameters<typeof proxyFetch>[0],
      init?: Parameters<typeof proxyFetch>[1],
    ) => proxyFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
  class FixtureGoogle extends GoogleProvider {
    protected getDiscoveryUri() {
      return `${origin}/discovery`;
    }
  }
  let onUpdate: (key: string) => void;
  const provider = new FixtureGoogle(
    {
      get: (key: string) =>
        key.endsWith("-clientId")
          ? "fixture-client"
          : key === "general.appUrl"
            ? "https://app.invalid"
            : "fixture-secret",
      addListener: (_event: string, listener: (key: string) => void) => {
        onUpdate = listener;
      },
    } as never,
    {} as never,
  );
  try {
    if (["deny", "wrong-host", "untrusted"].includes(mode)) {
      // Exercise JWKS TLS/routing failures independently of discovery fetch.
      provider.getConfiguration = async () =>
        ({
          issuer: "https://accounts.google.com",
          jwks_uri: `${origin}/keys`,
        }) as never;
      await assert.rejects(
        provider.getUserInfo(
          {
            idToken: process.env.OIDC_FIXTURE_TOKEN,
          } as never,
          { nonce: "fixture-nonce" } as never,
        ),
        (error: ErrorPageException) =>
          error instanceof ErrorPageException && error.key === "invalid_token",
      );
      return;
    }
    const auth = await provider.getAuthEndpoint("fixture-state");
    assert.equal(new URL(auth.url).searchParams.get("nonce"), auth.nonce);
    const query = { code: auth.nonce, nonce: auth.nonce };
    const oauthToken = await provider.getToken(query as never);
    const user = await provider.getUserInfo(oauthToken, query as never);
    assert.equal(user.providerId, "fixture-user");
    // The same remote resolver must reuse its verified key cache.
    await provider.getUserInfo(oauthToken, query as never);
    onUpdate!("oauth.google-enabled");
    await provider.getUserInfo(oauthToken, query as never);
  } finally {
    (provider as unknown as { deinit(): void }).deinit();
    globalThis.fetch = nativeFetch;
    await dispatcher?.close();
  }
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "privcloud-oidc-https-"));
  const sockets = new Set<Duplex>();
  const requests = new Map<string, number>();
  let tunnels = 0;
  let rejectTunnel = false;
  let upstreamPort = 0;
  let originServer: https.Server | undefined;
  let proxyServer: https.Server | undefined;
  const certificate = path.join(directory, "cert.pem");
  const key = path.join(directory, "key.pem");
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };
  const listen = async (server: https.Server) => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.on("connection", track);
    return (server.address() as { port: number }).port;
  };
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=oidc-fixture.invalid",
        "-addext",
        "subjectAltName=DNS:localhost,DNS:oidc-fixture.invalid,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const tls = {
      key: readFileSync(key),
      cert: readFileSync(certificate),
      minVersion: "TLSv1.2" as const,
    };
    const keys = await generateKeyPair("RS256");
    const publicKey = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fixture-key",
    };
    const issue = (nonce: string) =>
      new SignJWT({
        iss: "https://accounts.google.com",
        aud: "fixture-client",
        sub: "fixture-user",
        name: "Fixture",
        email_verified: true,
        nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    const dummyToken = await issue("fixture-nonce");
    originServer = https.createServer(tls, (request, response) => {
      const route = request.url ?? "";
      requests.set(route, (requests.get(route) ?? 0) + 1);
      response.setHeader("Content-Type", "application/json");
      const origin = `https://${request.headers.host}`;
      if (route === "/discovery") {
        response.end(
          JSON.stringify({
            issuer: "https://accounts.google.com",
            jwks_uri: `${origin}/keys`,
            token_endpoint: `${origin}/token`,
            authorization_endpoint: `${origin}/authorize`,
          }),
        );
      } else if (route === "/keys") {
        response.end(JSON.stringify({ keys: [publicKey] }));
      } else if (route === "/token" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) request.destroy();
        });
        request.on("end", () => {
          const nonce = new URLSearchParams(body).get("code") ?? "";
          void issue(nonce)
            .then((id_token) => response.end(JSON.stringify({ id_token })))
            .catch(() => response.destroy());
        });
      } else {
        response.writeHead(404).end();
      }
    });
    originServer.on("secureConnection", (socket) => {
      if (
        !["localhost", "oidc-fixture.invalid"].includes(socket.servername || "")
      ) {
        socket.destroy();
      }
    });
    upstreamPort = await listen(originServer);
    proxyServer = https.createServer(tls, (_request, response) =>
      response.writeHead(405).end(),
    );
    proxyServer.on("connect", (request, client, head) => {
      track(client);
      tunnels++;
      if (
        rejectTunnel ||
        ![
          `oidc-fixture.invalid:${upstreamPort}`,
          `wrong-host.invalid:${upstreamPort}`,
          `127.0.0.1:${upstreamPort}`,
          `localhost:${upstreamPort}`,
        ].includes(request.url ?? "")
      ) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(upstreamPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection established\r\n");
        // Real proxies can split the CONNECT response across TCP reads.
        setTimeout(() => {
          client.write("Proxy-Agent: fixture\r\n\r\n");
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        }, 20);
      });
      track(upstream);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
    const proxyPort = await listen(proxyServer);
    for (const mode of [
      "direct",
      "proxy",
      "bootstrap",
      "bypass",
      "deny",
      "wrong-host",
      "untrusted",
    ]) {
      const beforeKeys = requests.get("/keys") ?? 0;
      const beforeTunnels = tunnels;
      rejectTunnel = mode === "deny";
      const host = ["proxy", "bootstrap"].includes(mode)
        ? "oidc-fixture.invalid"
        : mode === "wrong-host"
          ? "wrong-host.invalid"
          : "localhost";
      const proxy = `https://127.0.0.1:${proxyPort}`;
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        // The bootstrap sits at the repository root, outside backend/: it
        // resolves global-agent from the backend's dependencies, as in the image.
        NODE_PATH: [process.cwd(), path.resolve("node_modules")].join(
          path.delimiter,
        ),
        NODE_USE_ENV_PROXY: "0",
        OIDC_FIXTURE_MODE: mode,
        OIDC_FIXTURE_ORIGIN: `https://${host}:${upstreamPort}`,
        OIDC_FIXTURE_TOKEN: dummyToken,
        ...(mode !== "untrusted" ? { NODE_EXTRA_CA_CERTS: certificate } : {}),
        ...(["proxy", "bootstrap", "deny", "wrong-host", "bypass"].includes(
          mode,
        )
          ? { HTTPS_PROXY: proxy }
          : {}),
        ...(mode === "bypass" ? { NO_PROXY: "localhost" } : {}),
      };
      const args = ["-r", "ts-node/register", __filename, "--probe"];
      if (mode === "bootstrap")
        args.unshift("-r", path.resolve("../global-agent-bootstrap.js"));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const timeout = setTimeout(() => child.kill(), 25_000);
        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`${mode} probe failed: ${output}`));
        });
      });
      if (["direct", "proxy", "bootstrap", "bypass"].includes(mode)) {
        assert.equal(
          (requests.get("/keys") ?? 0) - beforeKeys,
          2,
          "JWKS is cached until reset, then fetched again",
        );
      } else {
        assert.equal(
          requests.get("/keys") ?? 0,
          beforeKeys,
          "denied proxy or TLS validation must prevent retrieval",
        );
      }
      if (["proxy", "bootstrap", "deny", "wrong-host"].includes(mode)) {
        assert.ok(
          tunnels > beforeTunnels,
          `${mode} must use the explicit proxy`,
        );
      } else assert.equal(tunnels, beforeTunnels, `${mode} must remain direct`);
      console.log(`ok - OIDC HTTPS ${mode}`);
    }
    console.log("7 real HTTPS OIDC transport scenarios passed");
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [originServer, proxyServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            if (server) server.close(() => resolve());
            else resolve();
          }),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}

void (process.argv.includes("--probe") ? probe() : fixture()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
