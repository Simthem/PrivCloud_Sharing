import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(
  new URL("../src/privcloud-bridge.mjs", import.meta.url),
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForBridge(baseUrl, origin, child, logs) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Companion exited during startup:\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: { Origin: origin },
      });
      if (response.ok) return response.json();
    } catch {
      // The loopback listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Companion did not start:\n${logs.join("")}`);
}

test("an HTTP upload rejection does not crash the Companion", async (t) => {
  const webDav = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/file.txt") {
      res.writeHead(200, {
        "Content-Length": "3",
        "Content-Type": "text/plain",
      });
      res.end("abc");
      return;
    }
    res.writeHead(404).end();
  });
  const app = createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "upload rejected for test" }));
    });
  });

  const [webDavPort, appPort] = await Promise.all([
    listen(webDav),
    listen(app),
  ]);
  const origin = `http://127.0.0.1:${appPort}`;
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "privcloud-bridge-test-"));
  const probe = createServer();
  const bridgePort = await listen(probe);
  await close(probe);
  const logs = [];
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      PRIVCLOUD_BRIDGE_ALLOW_HTTP_WEBDAV: "1",
      PRIVCLOUD_BRIDGE_ORIGINS: origin,
      PRIVCLOUD_BRIDGE_PORT: String(bridgePort),
      PRIVCLOUD_BRIDGE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all([close(webDav), close(app)]);
    await rm(stateDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  const healthPayload = await waitForBridge(baseUrl, origin, child, logs);
  assert.equal(healthPayload.capabilities.localTokenAuthorization, true);
  assert.equal(healthPayload.capabilities.openSourceLocalAuthorization, true);

  const tokenResponse = await fetch(`${baseUrl}/v1/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ label: "regression test" }),
  });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();

  const createResponse = await fetch(`${baseUrl}/v1/jobs/webdav-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      appBaseUrl: origin,
      shareId: "test-share",
      uploadToken: "pcbu_regression-test",
      chunkSize: 3,
      webdav: {
        endpoint: `http://127.0.0.1:${webDavPort}/`,
        username: "test-user",
        password: "test-password",
      },
      files: [
        {
          href: `http://127.0.0.1:${webDavPort}/file.txt`,
          name: "file.txt",
          size: 3,
        },
      ],
    }),
  });
  assert.equal(createResponse.status, 202);
  const job = await createResponse.json();

  let state;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/jobs/${job.id}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    });
    assert.equal(response.status, 200);
    state = await response.json();
    if (state.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(state?.state, "failed");
  assert.equal(child.exitCode, null, logs.join(""));
  const health = await fetch(`${baseUrl}/v1/health`, {
    headers: { Origin: origin },
  });
  assert.equal(health.status, 200);
});

test("an encrypted Bridge upload declares its plaintext record size", async (t) => {
  const webDav = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Length": "1000000",
      "Content-Type": "application/octet-stream",
    });
    res.end(Buffer.alloc(1_000_000, 7));
  });
  let receivedUpload;
  const app = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", () => {
      receivedUpload = {
        chunkSize: url.searchParams.get("chunkSize"),
        encryptionChunkSize: url.searchParams.get("encryptionChunkSize"),
        bodyLength: Buffer.concat(chunks).length,
      };
      if (
        receivedUpload.chunkSize !== "1000000" ||
        receivedUpload.encryptionChunkSize !== "1000000" ||
        receivedUpload.bodyLength !== 1_000_028
      ) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "invalid encrypted chunk layout" }));
        return;
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "file-1" }));
    });
  });

  const [webDavPort, appPort] = await Promise.all([
    listen(webDav),
    listen(app),
  ]);
  const origin = `http://127.0.0.1:${appPort}`;
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "privcloud-bridge-test-"));
  const probe = createServer();
  const bridgePort = await listen(probe);
  await close(probe);
  const logs = [];
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      PRIVCLOUD_BRIDGE_ALLOW_HTTP_WEBDAV: "1",
      PRIVCLOUD_BRIDGE_ORIGINS: origin,
      PRIVCLOUD_BRIDGE_PORT: String(bridgePort),
      PRIVCLOUD_BRIDGE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all([close(webDav), close(app)]);
    await rm(stateDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  await waitForBridge(baseUrl, origin, child, logs);
  const tokenResponse = await fetch(`${baseUrl}/v1/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ label: "encrypted regression test" }),
  });
  const { token } = await tokenResponse.json();

  const createResponse = await fetch(`${baseUrl}/v1/jobs/webdav-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      appBaseUrl: origin,
      shareId: "encrypted-share",
      uploadToken: "pcbu_encrypted-regression-test",
      chunkSize: 1_000_000,
      isE2EEncrypted: true,
      encryptionKey: Buffer.alloc(32, 9).toString("base64url"),
      webdav: {
        endpoint: `http://127.0.0.1:${webDavPort}/`,
        username: "test-user",
        password: "test-password",
      },
      files: [
        {
          href: `http://127.0.0.1:${webDavPort}/file.bin`,
          name: "file.bin",
          size: 1_000_000,
        },
      ],
    }),
  });
  assert.equal(createResponse.status, 202);
  const job = await createResponse.json();

  let state;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/jobs/${job.id}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    });
    state = await response.json();
    if (["completed", "failed"].includes(state.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.deepEqual(receivedUpload, {
    chunkSize: "1000000",
    encryptionChunkSize: "1000000",
    bodyLength: 1_000_028,
  });
  assert.equal(state?.state, "completed", logs.join(""));
  assert.equal(child.exitCode, null, logs.join(""));
});

test("an untrusted app base URL never becomes an outbound target", async (t) => {
  const origin = "https://trusted.example";
  let outboundRequests = 0;
  const attacker = createServer((_req, res) => {
    outboundRequests += 1;
    res.writeHead(200).end("unexpected outbound request");
  });
  const attackerPort = await listen(attacker);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "privcloud-bridge-test-"));
  const probe = createServer();
  const bridgePort = await listen(probe);
  await close(probe);
  const logs = [];
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      PRIVCLOUD_BRIDGE_ORIGINS: origin,
      PRIVCLOUD_BRIDGE_PORT: String(bridgePort),
      PRIVCLOUD_BRIDGE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await close(attacker);
    await rm(stateDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  await waitForBridge(baseUrl, origin, child, logs);
  const tokenResponse = await fetch(`${baseUrl}/v1/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ label: "SSRF regression test" }),
  });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();

  const response = await fetch(`${baseUrl}/v1/jobs/webdav-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      appBaseUrl: `http://127.0.0.1:${attackerPort}`,
      shareId: "ssrf-regression",
      uploadToken: "pcbu_ssrf-regression",
      chunkSize: 1024,
      webdav: {
        endpoint: "https://webdav.example/",
        username: "test-user",
        password: "test-password",
      },
      files: [
        {
          href: "https://webdav.example/file.txt",
          name: "file.txt",
          size: 1,
        },
      ],
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "bad_request",
    message: "bridge.error.badRequest",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(outboundRequests, 0);
  assert.equal(child.exitCode, null, logs.join(""));
});
