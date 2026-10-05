import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createProbe } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(
  new URL("../src/privcloud-bridge.mjs", import.meta.url),
);
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const close = (server) => new Promise((resolve) => server.close(resolve));
const decrypt = (bytes, key, aad) => {
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  if (aad) cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]);
};

// Exercise the real executable, WebDAV reader, crypto and control/PUT paths together.
test("managed WebDAV jobs send encrypted bytes straight to S3 with protected names", async (t) => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "privcloud-direct-bridge-"),
  );
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const certPath = path.join(stateDir, "cert.pem");
  const keyPath = path.join(stateDir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore", timeout: 15000 },
  );
  const tls = {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
    minVersion: "TLSv1.2",
  };
  const key = randomBytes(32),
    content = randomBytes(19 * 1024 * 1024 + 7);
  const uploadToken = "pcbu_fixture";
  const name = "Private-client-financial-report.bin";
  const password = randomBytes(24).toString("base64url");
  const parts = new Map();
  const initialized = new Map();
  let finalized = 0,
    relayCalls = 0;
  const json = (res, body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const firstPuts = [];
  let puts = 0;
  const storage = createServer(tls, async (req, res) => {
    assert.equal(req.method, "PUT");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, Number(req.headers["content-length"]));
    const [fileId, partNumber] = req.url.slice(1).split("/");
    if (!parts.has(fileId)) parts.set(fileId, new Map());
    parts.get(fileId).set(Number(partNumber), decrypt(bytes, key));
    puts++;
    if (puts <= 4) {
      firstPuts.push(res);
      if (firstPuts.length === 4) {
        for (const response of firstPuts) response.writeHead(200, { ETag: '"fixture-etag"' }).end();
      }
    } else res.writeHead(200, { ETag: '"fixture-etag"' }).end();
  });
  const storagePort = await listen(storage);
  const davResponses = [];
  const dav = createServer(tls, (req, res) => {
    assert.equal(
      req.headers.authorization,
      "Basic " + Buffer.from("fixture:" + password).toString("base64"),
    );
    // Both source reads must open before either is released. Sequential files
    // cannot pass this fixture merely because small PUTs happen to be fast.
    davResponses.push(res);
    if (davResponses.length === 2) {
      for (const response of davResponses) {
        response.writeHead(200, {
          "Content-Length": String(content.length),
          ETag: '"fixture-v1"',
        });
        response.end(content);
      }
    }
  });
  const app = createServer(tls, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url.endsWith("/grants/redeem")) {
      json(res, {
        allowed: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }
    assert.equal(req.headers.authorization, "Bearer " + uploadToken);
    if (req.url.startsWith("/api/shares/direct-fixture/files/bridge?")) {
      relayCalls++;
      res.writeHead(500).end();
      return;
    }
    const text = Buffer.concat(chunks).toString();
    assert.ok(
      !text.includes(name) &&
        !text.includes(password) &&
        !text.includes(key.toString("base64url")),
    );
    const body = JSON.parse(text);
    if (req.url.endsWith("/init")) {
      initialized.set(body.id, body);
      assert.equal(body.name, `encrypted-file-${body.id.slice(0, 8)}`);
      const label = decrypt(
        Buffer.from(body.encryptedMetadata, "base64url"),
        key,
        `privcloud:file-meta:v1:direct-fixture:${body.id}`,
      );
      assert.deepEqual(JSON.parse(label.toString()), { v: 1, n: name });
      assert.equal(body.totalChunks, 3);
      assert.equal(body.chunkSize, 8 * 1024 * 1024);
      json(res, {
        id: body.id,
        uploadTransport: "direct-s3",
        uploadConcurrency: 2,
      });
      return;
    }
    assert.ok(initialized.has(body.id));
    if (req.url.endsWith("/part-urls")) {
      json(res, {
        parts: body.parts.map((part) => ({
          url: `https://127.0.0.1:${storagePort}/${body.id}/${part.chunkIndex + 1}`,
          contentLength: part.contentLength,
          partNumber: part.chunkIndex + 1,
        })),
      });
      return;
    }
    assert.ok(req.url.endsWith("/complete"));
    assert.equal(parts.get(body.id).size, 3);
    assert.deepEqual(
      Buffer.concat([1, 2, 3].map((part) => parts.get(body.id).get(part))),
      content,
    );
    finalized++;
    json(res, { id: body.id, uploadComplete: true });
  });
  const davPort = await listen(dav),
    appPort = await listen(app);
  const origin = `https://127.0.0.1:${appPort}`;
  const probe = createProbe(),
    bridgePort = await listen(probe);
  await close(probe);
  const logs = [];
  const child = spawn(process.execPath, [runtime], {
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: certPath,
      PRIVCLOUD_BRIDGE_ORIGINS: origin,
      PRIVCLOUD_BRIDGE_PORT: String(bridgePort),
      PRIVCLOUD_BRIDGE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => logs.push(data.toString()));
  child.stderr.on("data", (data) => logs.push(data.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all([close(dav), close(app), close(storage)]);
  });
  const base = `http://127.0.0.1:${bridgePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try {
      ready = (
        await fetch(base + "/v1/health", { headers: { Origin: origin } })
      ).ok;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(ready, true, logs.join(""));
  const paired = await fetch(base + "/v1/tokens", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ appBaseUrl: origin, grant: "A".repeat(43) }),
  });
  const { token } = await paired.json();
  const headers = {
    Origin: origin,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const created = await fetch(base + "/v1/jobs/webdav-upload", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appBaseUrl: origin,
      shareId: "direct-fixture",
      uploadToken,
      chunkSize: 16 * 1024 * 1024,
      isE2EEncrypted: true,
      encryptionKey: key.toString("base64url"),
      fileMetadataScheme: 1,
      webdav: {
        endpoint: `https://127.0.0.1:${davPort}/`,
        username: "fixture",
        password,
      },
      files: [
        {
          href: `https://127.0.0.1:${davPort}/file-a.bin`,
          name,
          size: content.length,
        },
        {
          href: `https://127.0.0.1:${davPort}/file-b.bin`,
          name,
          size: content.length,
        },
      ],
    }),
  });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    state = await (await fetch(base + "/v1/jobs/" + id, { headers })).json();
    if (["completed", "failed"].includes(state.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(state.state, "completed", logs.join(""));
  assert.equal(state.uploadedBytes, 2 * content.length);
  assert.equal(state.completedFiles, 2);
  assert.equal(initialized.size, 2);
  assert.equal(finalized, 2);
  assert.equal(firstPuts.length, 4);
  assert.equal(relayCalls, 0);
});
