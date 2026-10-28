import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto, { randomBytes } from "node:crypto";
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

test("a Companion upload under a key with a v2 floor writes E2EE content v2", async (t) => {
  const plain = Buffer.alloc(1_000_005, 3);
  const webDav = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Length": String(plain.length),
      "Content-Type": "application/octet-stream",
    });
    res.end(plain);
  });
  const uploads = [];
  const app = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", () => {
      uploads.push({ query: url.searchParams, body: Buffer.concat(chunks) });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: url.searchParams.get("id") }));
    });
  });
  const [webDavPort, appPort] = await Promise.all([listen(webDav), listen(app)]);
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
  const health = await (
    await fetch(`${baseUrl}/v1/health`, { headers: { Origin: origin } })
  ).json();
  assert.equal(health.capabilities.contentV2, true);
  const { token } = await (
    await fetch(`${baseUrl}/v1/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ label: "content v2 test" }),
    })
  ).json();
  const rawKey = randomBytes(32);
  const createResponse = await fetch(`${baseUrl}/v1/jobs/webdav-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      appBaseUrl: origin,
      shareId: "floor-share",
      uploadToken: "pcbu_content-v2-test",
      chunkSize: 1_000_000,
      isE2EEncrypted: true,
      encryptionKey: Buffer.concat([Buffer.from([2]), rawKey]).toString(
        "base64url",
      ),
      webdav: {
        endpoint: `http://127.0.0.1:${webDavPort}/`,
        username: "test-user",
        password: randomBytes(24).toString("base64url"),
      },
      files: [
        {
          href: `http://127.0.0.1:${webDavPort}/file.bin`,
          name: "file.bin",
          size: plain.length,
        },
      ],
    }),
  });
  assert.equal(createResponse.status, 202);
  const job = await createResponse.json();
  let state;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    state = await (
      await fetch(`${baseUrl}/v1/jobs/${job.id}`, {
        headers: { Authorization: `Bearer ${token}`, Origin: origin },
      })
    ).json();
    if (["completed", "failed"].includes(state.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(state?.state, "completed", logs.join(""));
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    assert.equal(upload.query.get("contentScheme"), "2");
    assert.equal(upload.query.get("encryptionChunkSize"), "1000000");
  }

  // Independent decryption with the specified derivation and additional data.
  const stored = Buffer.concat(uploads.map((upload) => upload.body));
  const fileId = uploads[0].query.get("id");
  const field = (value) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const header = stored.subarray(0, 32);
  assert.deepEqual(
    header.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x43, 0x45, 0x32, 0x0d, 0x0a, 0x1a]),
  );
  const identity = Buffer.concat([field("share-file"), field(fileId)]);
  // HKDF-SHA256 (RFC 5869) written out, so this check shares no derivation code
  // with the writer. The v2 format uses an empty salt, which HMAC pads into an
  // all zero key: extracting is then SHA-256 over the bare ipad and opad blocks.
  const prk = crypto
    .createHash("sha256")
    .update(Buffer.alloc(64, 0x5c))
    .update(
      crypto
        .createHash("sha256")
        .update(Buffer.alloc(64, 0x36))
        .update(rawKey)
        .digest(),
    )
    .digest();
  const fileKey = crypto
    .createHmac("sha256", prk)
    .update(field("privcloud:content:v2:key"))
    .update(header)
    .update(identity)
    .update(Buffer.from([1]))
    .digest();
  const records = [
    stored.subarray(32, 32 + 1_000_028),
    stored.subarray(32 + 1_000_028),
  ];
  const opened = records.map((record, index) => {
    const position = Buffer.alloc(9);
    position.writeBigUInt64BE(BigInt(index));
    position[8] = index === records.length - 1 ? 1 : 0;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      fileKey,
      record.subarray(0, 12),
    );
    decipher.setAAD(
      Buffer.concat([
        field("privcloud:content:v2:record"),
        header,
        identity,
        position,
      ]),
    );
    decipher.setAuthTag(record.subarray(record.length - 16));
    return Buffer.concat([
      decipher.update(record.subarray(12, record.length - 16)),
      decipher.final(),
    ]);
  });
  assert.deepEqual(Buffer.concat(opened), plain);
});
