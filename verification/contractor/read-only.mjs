import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Read-only HTTPS audit of a prepared test tenant. Never creates seats or sends invitations. */
export async function verifyReadOnly(config) {
  const origin = new URL(config.origin);
  assert.ok(
    !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/",
    "Use an origin without credentials or a path",
  );
  assert.equal(
    origin.protocol,
    "https:",
    "HTTPS is required, including loopback fixtures",
  );
  for (const name of [
    "teamId",
    "shareId",
    "fileId",
    "previewId",
    "revokedPreviewId",
    "expiredPreviewId",
    "otherPreviewId",
  ])
    assert.match(
      config[name],
      /^[A-Za-z0-9_-]{1,128}$/,
      "Invalid test resource identifier",
    );
  assert.match(
    config.pageCipherSha256,
    /^[a-f0-9]{64}$/,
    "Pin the expected page ciphertext hash",
  );
  const normalizedSessions = [];
  for (const headers of [config.ownerHeaders, config.contractorHeaders]) {
    assert.ok(
      Object.keys(headers).length > 0,
      "An authenticated session is required",
    );
    for (const [key, value] of Object.entries(headers))
      assert.ok(
        /^(authorization|cookie)$/i.test(key) &&
          typeof value === "string" &&
          value.length > 0 &&
          !/[\r\n]/.test(value),
        "Only session headers are accepted",
      );
    normalizedSessions.push(
      JSON.stringify([...new Headers(headers).entries()].sort()),
    );
  }
  assert.notEqual(
    normalizedSessions[0],
    normalizedSessions[1],
    "Use two distinct authenticated sessions",
  );
  const report = [];
  const request = async (
    label,
    path,
    headers,
    expected,
    { range, maxBytes = 4096, sha256, json = false } = {},
  ) => {
    const response = await fetch(new URL("/api/" + path, origin), {
      headers: { ...headers, ...(range ? { Range: range } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    assert.ok(
      expected.includes(response.status),
      `${label}: unexpected HTTP ${response.status}`,
    );
    assert.ok(
      !response.headers.get("content-type")?.toLowerCase().includes("text/html"),
      `${label}: received HTML instead of an API response`,
    );
    let chunks = [],
      bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          assert.ok(bytes <= maxBytes, `${label}: response exceeded the limit`);
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    const body = Buffer.concat(chunks);
    if (sha256)
      assert.equal(
        createHash("sha256").update(body).digest("hex"),
        sha256,
        `${label}: page ciphertext was modified`,
      );
    if (range)
      assert.ok(
        response.headers.get("content-range")?.startsWith("bytes 0-0/") &&
          bytes === 1,
        `${label}: owner positive control must serve exactly one original byte`,
      );
    if (json) {
      const value = JSON.parse(body.toString());
      assert.equal(
        value.id,
        config.previewId,
        "The returned preview must match the test copy",
      );
      for (const field of [
        "sourceFileId",
        "teamKey",
        "wrappedTeamKey",
        "wrappedShareKey",
        "encryptedFileKey",
      ])
        assert.ok(
          !(field in value),
          "Preview response exposed original access material",
        );
      assert.equal(
        typeof value.encryptedManifest,
        "string",
        "Expected an encrypted rendered-page manifest",
      );
    }
    report.push({ check: label, status: response.status, passed: true });
  };
  const original = `shares/${config.shareId}/files/${config.fileId}`;
  await request(
    "owner-original-positive-control",
    original,
    config.ownerHeaders,
    [206],
    { range: "bytes=0-0", maxBytes: 1 },
  );
  await request(
    "contractor-own-preview",
    `external/previews/${config.previewId}`,
    config.contractorHeaders,
    [200],
    { json: true, maxBytes: 1024 * 1024 },
  );
  await request(
    "contractor-own-encrypted-page",
    `external/previews/${config.previewId}/pages/0`,
    config.contractorHeaders,
    [200],
    { sha256: config.pageCipherSha256, maxBytes: 16 * 1024 * 1024 },
  );
  for (const [label, path] of [
    ["original-denied", original],
    ["direct-original-denied", original + "/direct"],
    ["original-file-key-denied", `crypto/grants/file/${config.fileId}`],
    ["original-share-key-denied", `shares/${config.shareId}/e2e-key`],
    ["team-key-denied", `teams/${config.teamId}/team-key`],
    ["team-access-denied", `teams/${config.teamId}`],
    ["revoked-preview-denied", `external/previews/${config.revokedPreviewId}`],
    [
      "revoked-page-denied",
      `external/previews/${config.revokedPreviewId}/pages/0`,
    ],
    ["expired-preview-denied", `external/previews/${config.expiredPreviewId}`],
    [
      "expired-page-denied",
      `external/previews/${config.expiredPreviewId}/pages/0`,
    ],
    ["other-seat-preview-denied", `external/previews/${config.otherPreviewId}`],
    [
      "other-seat-page-denied",
      `external/previews/${config.otherPreviewId}/pages/0`,
    ],
  ])
    await request(label, path, config.contractorHeaders, [403, 404]);
  await request(
    "anonymous-preview-denied",
    `external/previews/${config.previewId}`,
    {},
    [401, 403, 404],
  );
  return { format: "privcloud-read-only-http-audit-v1", checks: report };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv[2], "Provide a private JSON configuration file");
    const name = path.basename(process.argv[2]);
    assert.ok(
      name === process.argv[2] && name.endsWith(".json"),
      "Run from the directory holding the private .json configuration and pass its name",
    );
    const configuration = path.join(process.cwd(), name);
    const metadata = await lstat(configuration);
    assert.ok(
      metadata.isFile() && !metadata.isSymbolicLink(),
      "The private configuration must be a regular file, not a link",
    );
    assert.ok(
      metadata.size <= 64 * 1024,
      "The private configuration exceeds 64 KiB",
    );
    if (process.platform !== "win32")
      assert.equal(
        metadata.mode & 0o077,
        0,
        "Protect the private configuration with chmod 600",
      );
    const result = await verifyReadOnly(
      JSON.parse(await readFile(configuration, "utf8")),
    );
    // No sessions, origins, resource identifiers, keys or response bodies are logged.
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
