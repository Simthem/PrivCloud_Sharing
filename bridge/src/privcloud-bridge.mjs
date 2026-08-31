#!/usr/bin/env node
import { createServer as createLoopbackHttpServer } from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

const VERSION = "1.24.3";
const NATIVE_HOST_NAME = "fr.privcloud.companion";
const HOST = process.env.PRIVCLOUD_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.PRIVCLOUD_BRIDGE_PORT || "47631");
const STATE_DIR =
  process.env.PRIVCLOUD_BRIDGE_STATE_DIR ||
  path.join(os.homedir(), ".privcloud-bridge");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const MAX_JSON_BODY = 256 * 1024;
const MAX_PROPFIND_XML = 5 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 64;
const MAX_FILES_PER_JOB = 1000;
const JOB_RETENTION_MS = 10 * 60 * 1000;
const ACTIVE_JOB_STALE_MS = 5 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIGURED_TOKEN_TTL_MS = Number(
  process.env.PRIVCLOUD_BRIDGE_TOKEN_TTL_MS || DEFAULT_TOKEN_TTL_MS,
);
const TOKEN_TTL_MS =
  Number.isFinite(CONFIGURED_TOKEN_TTL_MS) && CONFIGURED_TOKEN_TTL_MS >= 0
    ? CONFIGURED_TOKEN_TTL_MS
    : DEFAULT_TOKEN_TTL_MS;
const MAX_STORED_TOKENS = 25;
const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://share.example.com",
];
const ALLOWED_ORIGINS = new Set(
  (process.env.PRIVCLOUD_BRIDGE_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const NATIVE_ALLOWED_ORIGINS = new Set(
  (process.env.PRIVCLOUD_COMPANION_NATIVE_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function assertLoopbackBindHost(host) {
  const normalized = String(host || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (normalized !== "127.0.0.1" && normalized !== "::1") {
    throw new Error(
      "PRIVCLOUD_BRIDGE_HOST must be the literal loopback address 127.0.0.1 or ::1.",
    );
  }
}

function isLoopbackPeer(address) {
  const normalized = String(address || "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function assertLoopbackPeer(req) {
  if (!isLoopbackPeer(req.socket?.remoteAddress)) {
    const err = new Error("Bridge requests must originate from loopback");
    err.statusCode = 403;
    throw err;
  }
}

let state = {
  bridgeId: crypto.randomUUID(),
  tokens: [],
};
const pendingPairings = new Map();
const jobs = new Map();
const PUBLIC_ERROR_MESSAGES = {
  bad_request: "bridge.error.badRequest",
  bridge_file_selection_limit: "bridge.error.fileSelectionLimit",
  bridge_too_many_jobs: "bridge.error.tooManyJobs",
  https_required: "webdav.error.https",
  internal_error: "bridge.error.internal",
  job_not_found: "bridge.error.jobNotFound",
  privcloud_rate_limited: "upload.error.rateLimited",
  privcloud_upload_rejected: "upload.error.rejected",
  webdav_auth_rejected: "webdav.error.auth",
  webdav_redirect_refused: "webdav.error.redirectRefused",
  webdav_same_origin_required: "webdav.error.sameOriginRequired",
  webdav_upstream_error: "webdav.error.upstream",
};
const ERROR_RESPONSE_JSON = Object.freeze(
  Object.fromEntries(
    Object.entries(PUBLIC_ERROR_MESSAGES).map(([code, message]) => [
      code,
      JSON.stringify({ error: code, message }),
    ]),
  ),
);

function now() {
  return Date.now();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeHexEqual(a, b) {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function tokenExpiresAt(token) {
  if (typeof token.expiresAt === "string") {
    const parsed = Date.parse(token.expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const createdAt = Date.parse(token.createdAt || "");
  if (!Number.isFinite(createdAt)) return 0;
  return createdAt + TOKEN_TTL_MS;
}

function tokenIsFresh(token) {
  return TOKEN_TTL_MS <= 0 || tokenExpiresAt(token) > now();
}

function pruneTokens() {
  state.tokens = state.tokens
    .filter((token) => typeof token.hash === "string" && tokenIsFresh(token))
    .slice(-MAX_STORED_TOKENS);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.bridgeId === "string" &&
      Array.isArray(parsed.tokens)
    ) {
      state = {
        bridgeId: parsed.bridgeId,
        tokens: parsed.tokens.filter((token) => typeof token.hash === "string"),
      };
      pruneTokens();
    }
  } catch {
    await saveState();
  }
}

async function saveState() {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function allowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin);
}

function setCommonHeaders(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // Echo back requested headers (Chrome PNA preflights may include extra headers)
  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders || "Content-Type, Authorization",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Required for Chrome Private Network Access (localhost from public origin)
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, Content-Length, Content-Type",
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function assertOrigin(req) {
  const origin = req.headers.origin;
  if (!origin && process.env.PRIVCLOUD_BRIDGE_ALLOW_NO_ORIGIN === "1") return;
  if (!allowedOrigin(origin)) {
    const err = new Error("Origin is not allowed");
    err.statusCode = 403;
    throw err;
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function publicErrorFrom(err) {
  const candidateStatus = Number(err?.statusCode || 500);
  const statusCode =
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 400 &&
    candidateStatus <= 599
      ? candidateStatus
      : 500;
  const rawCode = String(
    err?.code || (statusCode >= 500 ? "internal_error" : "bad_request"),
  );
  const code = Object.prototype.hasOwnProperty.call(
    PUBLIC_ERROR_MESSAGES,
    rawCode,
  )
    ? rawCode
    : statusCode >= 500
      ? "internal_error"
      : "bad_request";

  // Log internal errors server-side only.
  if (statusCode >= 500 && err) {
    console.error(`[Bridge] Internal error: ${err.message || err}`);
  }

  return {
    statusCode,
    code,
  };
}

function sendError(res, err) {
  const publicError = publicErrorFrom(err);
  res.writeHead(publicError.statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(
    ERROR_RESPONSE_JSON[publicError.code] || ERROR_RESPONSE_JSON.internal_error,
  );
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY) {
      const err = new Error("Request body too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

function authenticate(req) {
  pruneTokens();
  const header = req.headers.authorization;
  const parts =
    typeof header === "string" ? header.trim().split(/\s+/u) : [];
  if (
    parts.length !== 2 ||
    parts[0].toLowerCase() !== "bearer" ||
    !parts[1]
  ) {
    const err = new Error("Missing bridge bearer token");
    err.statusCode = 401;
    throw err;
  }
  const presentedHash = sha256(parts[1]);
  const token = state.tokens.find((candidate) =>
    timingSafeHexEqual(candidate.hash, presentedHash),
  );
  if (!token) {
    const err = new Error("Invalid bridge bearer token");
    err.statusCode = 401;
    throw err;
  }
  token.lastUsedAt = new Date().toISOString();
  void saveState();
  return token;
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function discardResponseBody(response) {
  const body = response?.body;
  if (!body || body.locked) return;
  try {
    await body.cancel();
  } catch {
    // A failed cleanup must never terminate the long-running Companion.
  }
}

function normalizeWebDavUrl(value, allowHttp = false) {
  if (typeof value !== "string" || value.trim().length === 0) {
    const err = new Error("endpoint is required");
    err.statusCode = 400;
    throw err;
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    const err = new Error("Invalid WebDAV URL");
    err.statusCode = 400;
    throw err;
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    const err = new Error("WebDAV URL must use HTTPS");
    err.statusCode = 400;
    err.code = "https_required";
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error("Credentials in WebDAV URLs are refused");
    err.statusCode = 400;
    throw err;
  }
  url.username = "";
  url.password = "";
  return url;
}

function resolveWebDavHref(endpoint, href) {
  const base = normalizeWebDavUrl(
    endpoint,
    process.env.PRIVCLOUD_BRIDGE_ALLOW_HTTP_WEBDAV === "1",
  );
  const target = href ? new URL(String(href), base) : base;
  if (target.origin !== base.origin) {
    const err = new Error("WebDAV href must stay on the same origin");
    err.statusCode = 400;
    err.code = "webdav_same_origin_required";
    throw err;
  }
  target.username = "";
  target.password = "";
  return target;
}

function normalizePrivCloudBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    const err = new Error("Invalid PrivCloud base URL");
    err.statusCode = 400;
    throw err;
  }

  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    const err = new Error("PrivCloud API URL must use HTTPS");
    err.statusCode = 400;
    throw err;
  }

  // The outbound API target comes from the administrator-controlled Bridge
  // allowlist, never from an HTTP Origin header. This keeps a forged local
  // request from turning the Companion into an SSRF proxy.
  if (!ALLOWED_ORIGINS.has(url.origin)) {
    const err = new Error("PrivCloud API URL is not in the Bridge allowlist");
    err.statusCode = 400;
    throw err;
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.origin;
}

function sanitizeFileName(name) {
  const clean = String(name || "webdav-file")
    .replace(/[\r\n\x00]/g, "_")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 255);
  if (!clean || clean.includes("..")) {
    const err = new Error("Invalid file name");
    err.statusCode = 400;
    throw err;
  }
  return clean;
}

function decodeBase64UrlKey(value) {
  try {
    const key = Buffer.from(String(value || ""), "base64url");
    if (key.length !== 32) throw new Error("bad length");
    return key;
  } catch {
    const err = new Error("Invalid encryption key");
    err.statusCode = 400;
    throw err;
  }
}

function encryptChunk(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
}

function directoryUrl(url) {
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function decodeXml(value = "") {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function stripCdata(value) {
  const trimmed = value.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(trimmed);
  return cdata ? cdata[1] : trimmed;
}

function tagText(xml, localName) {
  const pattern = new RegExp(
    `<[^>]*:?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/[^>]*:?${localName}>`,
    "i",
  );
  const match = pattern.exec(xml);
  if (!match) return undefined;
  return decodeXml(stripCdata(match[1]));
}

function hasCollection(xml) {
  return /<[^>]*:?collection(?:\s[^>]*)?\/?>/i.test(xml);
}

function splitResponses(xml) {
  const matches = xml.match(
    /<[^>]*:?response(?:\s[^>]*)?>[\s\S]*?<\/[^>]*:?response>/gi,
  );
  return matches || [];
}

function entryNameFromHref(url) {
  const clean = url.pathname.replace(/\/+$/, "");
  const raw = clean.split("/").pop() || clean || "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sameResource(a, b) {
  const clean = (value) => value.pathname.replace(/\/+$/, "") || "/";
  return a.origin === b.origin && clean(a) === clean(b);
}

function parseWebDavMultiStatus(xml, baseUrl) {
  const root = new URL(baseUrl);
  const entries = [];
  for (const response of splitResponses(xml)) {
    const hrefText = tagText(response, "href");
    if (!hrefText) continue;
    const href = new URL(hrefText, root.origin);
    href.username = "";
    href.password = "";
    if (href.origin !== root.origin || sameResource(href, root)) continue;

    const size = Number(tagText(response, "getcontentlength") || "0");
    const isDirectory = hasCollection(response) || href.pathname.endsWith("/");
    entries.push({
      id: href.href,
      name: tagText(response, "displayname") || entryNameFromHref(href),
      href: href.href,
      isDirectory,
      size: Number.isFinite(size) ? size : 0,
      contentType: tagText(response, "getcontenttype") || undefined,
      lastModified: tagText(response, "getlastmodified") || undefined,
    });
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function webDavFetch({
  endpoint,
  username,
  password,
  href,
  method,
  body,
  headers = {},
  signal,
}) {
  if (!username || !password) {
    const err = new Error("WebDAV username and password are required");
    err.statusCode = 400;
    throw err;
  }
  const target = resolveWebDavHref(endpoint, href);
  const response = await fetch(target, {
    method,
    headers: {
      Authorization: basicAuth(username, password),
      "User-Agent": `PrivCloud-Bridge/${VERSION}`,
      ...headers,
    },
    body,
    redirect: "manual",
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    await discardResponseBody(response);
    const err = new Error("WebDAV authentication rejected");
    err.statusCode = 401;
    err.code = "webdav_auth_rejected";
    throw err;
  }
  if (response.status >= 300 && response.status < 400) {
    await discardResponseBody(response);
    const err = new Error("WebDAV redirect refused");
    err.statusCode = 400;
    err.code = "webdav_redirect_refused";
    throw err;
  }
  if (!response.ok && response.status !== 207) {
    await discardResponseBody(response);
    const err = new Error(`WebDAV request failed with HTTP ${response.status}`);
    err.statusCode = 502;
    err.code = "webdav_upstream_error";
    throw err;
  }
  return { response, target };
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      const err = new Error("WebDAV response too large");
      err.statusCode = 502;
      throw err;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cancellableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          const err = new Error("Job cancelled");
          err.code = "job_cancelled";
          reject(err);
        },
        { once: true },
      );
    }
  });
}

function throwIfCancelled(job) {
  if (!job.cancelled && !job.abortController.signal.aborted) return;
  const err = new Error("Job cancelled");
  err.code = "job_cancelled";
  throw err;
}

async function* readPlaintextChunks(stream, chunkSize, job, declaredSize) {
  const reader = stream?.getReader();
  if (!reader) {
    const err = new Error("WebDAV response has no body");
    err.statusCode = 502;
    throw err;
  }

  let buffer = Buffer.allocUnsafe(chunkSize);
  let fill = 0;
  let bytesRead = 0;
  let yielded = false;

  try {
    for (;;) {
      throwIfCancelled(job);
      const { done, value } = await reader.read();
      if (done) break;
      const incoming = Buffer.from(value);
      bytesRead += incoming.length;
      let offset = 0;
      while (offset < incoming.length) {
        const copyLength = Math.min(chunkSize - fill, incoming.length - offset);
        incoming.copy(buffer, fill, offset, offset + copyLength);
        fill += copyLength;
        offset += copyLength;
        if (fill === chunkSize) {
          yielded = true;
          yield Buffer.from(buffer);
          fill = 0;
        }
      }
    }

    if (fill > 0) {
      yielded = true;
      yield Buffer.from(buffer.subarray(0, fill));
    }

    if (!yielded && declaredSize === 0) {
      yield Buffer.alloc(0);
    }
  } finally {
    reader.releaseLock();
  }
}

function buildBridgeUploadUrl(
  appBaseUrl,
  shareId,
  fileId,
  chunkIndex,
  totalChunks,
  chunkSize,
  encryptionChunkSize,
) {
  const url = new URL(
    `/api/shares/${encodeURIComponent(shareId)}/files/bridge`,
    appBaseUrl,
  );
  url.searchParams.set("chunkIndex", String(chunkIndex));
  url.searchParams.set("totalChunks", String(totalChunks));
  url.searchParams.set("chunkSize", String(chunkSize));
  if (encryptionChunkSize) {
    url.searchParams.set("encryptionChunkSize", String(encryptionChunkSize));
  }
  if (fileId) url.searchParams.set("id", fileId);
  return url;
}

async function uploadPrivCloudChunk({
  appBaseUrl,
  shareId,
  uploadToken,
  fileName,
  fileId,
  chunkIndex,
  totalChunks,
  chunkSize,
  encryptionChunkSize,
  body,
  job,
}) {
  const retryableStatuses = new Set([502, 503, 504]);
  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfCancelled(job);
    const url = buildBridgeUploadUrl(
      appBaseUrl,
      shareId,
      fileId,
      chunkIndex,
      totalChunks,
      chunkSize,
      encryptionChunkSize,
    );

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(fileName),
          "X-PrivCloud-Bridge": state.bridgeId,
          "User-Agent": `PrivCloud-Bridge/${VERSION}`,
        },
        body,
        redirect: "manual",
        signal: job.abortController.signal,
      });
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await cancellableSleep(
        Math.min(1000 * 2 ** attempt, 30_000),
        job.abortController.signal,
      );
      continue;
    }

    if (response.ok) {
      return response.json();
    }

    const status = response.status;
    const data = await response.json().catch(() => null);

    if (
      (retryableStatuses.has(status) || status >= 500) &&
      attempt < maxAttempts
    ) {
      await cancellableSleep(
        Math.min(1000 * 2 ** attempt, 30_000),
        job.abortController.signal,
      );
      continue;
    }

    const err = new Error(
      data?.message || `PrivCloud upload failed with HTTP ${status}`,
    );
    err.statusCode = status;
    err.code =
      status === 429 ? "privcloud_rate_limited" : "privcloud_upload_rejected";
    throw err;
  }

  throw new Error("PrivCloud upload failed");
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    totalBytes: job.totalBytes,
    uploadedBytes: job.uploadedBytes,
    totalFiles: job.files.length,
    completedFiles: job.completedFiles,
    currentFileName: job.currentFileName,
    error: job.error,
    files: job.files.map((file) => ({
      name: file.name,
      size: file.size,
      state: file.state,
      uploadedBytes: file.uploadedBytes,
      error: file.error,
    })),
  };
}

function touchJob(job) {
  job.updatedAt = new Date().toISOString();
}

async function runWebDavUploadJob(job, payload) {
  job.state = "running";
  touchJob(job);

  try {
    for (let index = 0; index < payload.files.length; index++) {
      throwIfCancelled(job);
      const selected = payload.files[index];
      const fileState = job.files[index];
      fileState.state = "running";
      job.currentFileName = fileState.name;
      touchJob(job);

      const { response } = await webDavFetch({
        endpoint: payload.webdav.endpoint,
        username: payload.webdav.username,
        password: payload.webdav.password,
        href: selected.href,
        method: "GET",
        signal: job.abortController.signal,
      });

      const declaredSize = Number(
        response.headers.get("content-length") || selected.size || 0,
      );
      if (!Number.isFinite(declaredSize) || declaredSize < 0) {
        throw new Error(`Unknown size for ${fileState.name}`);
      }
      if (declaredSize !== fileState.size) {
        job.totalBytes += declaredSize - fileState.size;
        fileState.size = declaredSize;
      }
      const totalChunks = Math.max(
        1,
        Math.ceil(declaredSize / payload.chunkSize),
      );
      if (totalChunks > 10000) {
        throw new Error(`Too many chunks for ${fileState.name}`);
      }

      let fileId;
      let chunkIndex = 0;
      let bytesRead = 0;
      for await (const plainChunk of readPlaintextChunks(
        response.body,
        payload.chunkSize,
        job,
        declaredSize,
      )) {
        throwIfCancelled(job);
        const uploadBody = payload.encryptionKey
          ? encryptChunk(plainChunk, payload.encryptionKey)
          : plainChunk;
        const result = await uploadPrivCloudChunk({
          appBaseUrl: payload.appBaseUrl,
          shareId: payload.shareId,
          uploadToken: payload.uploadToken,
          fileName: fileState.name,
          fileId,
          chunkIndex,
          totalChunks,
          chunkSize: payload.chunkSize,
          encryptionChunkSize: payload.encryptionKey
            ? payload.chunkSize
            : undefined,
          body: uploadBody,
          job,
        });
        fileId = result.id;
        chunkIndex += 1;
        bytesRead += plainChunk.length;
        fileState.uploadedBytes = Math.min(bytesRead, declaredSize);
        job.uploadedBytes += plainChunk.length;
        touchJob(job);
      }

      if (bytesRead !== declaredSize) {
        throw new Error(`WebDAV size changed while reading ${fileState.name}`);
      }

      fileState.state = "completed";
      fileState.uploadedBytes = declaredSize;
      job.completedFiles += 1;
      touchJob(job);
    }

    job.currentFileName = null;
    job.state = "completed";
    touchJob(job);
  } catch (err) {
    if (err?.code === "job_cancelled" || job.cancelled) {
      job.state = "cancelled";
      job.error = "Job cancelled";
    } else {
      job.state = "failed";
      job.error =
        PUBLIC_ERROR_MESSAGES[err?.code] ||
        (err?.statusCode && err.statusCode < 500
          ? "bridge.error.badRequest"
          : "bridge.error.internal");
      const current = job.files.find((file) => file.state === "running");
      if (current) {
        current.state = "failed";
        current.error = job.error;
      }
    }
    job.currentFileName = null;
    touchJob(job);
  }
}

function cleanupJobs() {
  const terminalCutoff = now() - JOB_RETENTION_MS;
  const activeCutoff = now() - ACTIVE_JOB_STALE_MS;
  for (const [id, job] of jobs) {
    if (
      !["completed", "failed", "cancelled"].includes(job.state) &&
      Date.parse(job.updatedAt) < activeCutoff
    ) {
      job.cancelled = true;
      job.abortController.abort();
      job.state = "failed";
      job.error = "bridge.error.staleJob";
      job.currentFileName = null;
      touchJob(job);
    }

    if (
      ["completed", "failed", "cancelled"].includes(job.state) &&
      Date.parse(job.updatedAt) < terminalCutoff
    ) {
      jobs.delete(id);
    }
  }
}

function bridgeHealthPayload() {
  cleanupJobs();
  const activeJobs = Array.from(jobs.values()).filter(
    (job) => !["completed", "failed", "cancelled"].includes(job.state),
  ).length;
  return {
    name: "PrivCloud Companion",
    version: VERSION,
    bridgeId: state.bridgeId,
    paired: state.tokens.length > 0,
    nativeHost: NATIVE_HOST_NAME,
    capabilities: {
      webdav: true,
      directBrowserImport: true,
      managedEncryptedUpload: true,
      localTokenAuthorization: true,
      openSourceLocalAuthorization: true,
      nativeMessaging: true,
      browserExtension: true,
      mailAssistants: true,
    },
    allowedOrigins: Array.from(ALLOWED_ORIGINS),
    jobs: {
      active: activeJobs,
      total: jobs.size,
      maxActive: MAX_ACTIVE_JOBS,
      maxFilesPerJob: MAX_FILES_PER_JOB,
      staleAfterMs: ACTIVE_JOB_STALE_MS,
    },
  };
}

function assertNativeOrigin(origin) {
  if (
    typeof origin === "string" &&
    (origin.startsWith("chrome-extension://") ||
      origin.startsWith("moz-extension://"))
  ) {
    return;
  }
  if (!origin || NATIVE_ALLOWED_ORIGINS.has(origin)) return;
  const err = new Error("Origin is not allowed");
  err.statusCode = 403;
  throw err;
}

async function handleNativeMessage(message) {
  const id = message?.id || crypto.randomUUID();
  try {
    assertNativeOrigin(message?.origin);
    const payload = message?.payload || {};
    let result;

    switch (message?.type) {
      case "health":
        result = bridgeHealthPayload();
        break;
      case "webdav.list": {
        const endpointUrl = directoryUrl(
          resolveWebDavHref(payload.endpoint, payload.href),
        );
        const propfindBody =
          '<?xml version="1.0" encoding="utf-8" ?>' +
          '<d:propfind xmlns:d="DAV:"><d:prop>' +
          "<d:displayname /><d:resourcetype /><d:getcontentlength />" +
          "<d:getcontenttype /><d:getlastmodified />" +
          "</d:prop></d:propfind>";
        const { response, target } = await webDavFetch({
          endpoint: payload.endpoint,
          username: payload.username,
          password: payload.password,
          href: endpointUrl.href,
          method: "PROPFIND",
          body: propfindBody,
          headers: {
            Depth: "1",
            "Content-Type": "application/xml; charset=utf-8",
            Accept: "application/xml,text/xml",
          },
        });
        const xml = await readLimitedText(response, MAX_PROPFIND_XML);
        result = {
          url: target.href,
          entries: parseWebDavMultiStatus(xml, target.href),
        };
        break;
      }
      case "webdav.upload.start":
        result = createWebDavUploadJob(payload, message.origin);
        break;
      case "jobs.get": {
        const job = jobs.get(String(payload.jobId || ""));
        if (!job) {
          const err = new Error("Bridge job not found");
          err.statusCode = 404;
          err.code = "job_not_found";
          throw err;
        }
        result = publicJob(job);
        break;
      }
      case "jobs.cancel": {
        const job = jobs.get(String(payload.jobId || ""));
        if (!job) {
          const err = new Error("Bridge job not found");
          err.statusCode = 404;
          err.code = "job_not_found";
          throw err;
        }
        if (!["completed", "failed", "cancelled"].includes(job.state)) {
          job.cancelled = true;
          job.abortController.abort();
          job.state = "cancelled";
          job.error = "Job cancelled";
          touchJob(job);
        }
        result = publicJob(job);
        break;
      }
      default: {
        const err = new Error("Unknown native command");
        err.statusCode = 400;
        throw err;
      }
    }

    return { id, ok: true, result };
  } catch (err) {
    return {
      id,
      ok: false,
      error: {
        code: err?.code || "native_error",
        statusCode: Number(err?.statusCode || 500),
        message: err?.message || "Native command failed",
      },
    };
  }
}

function writeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function runNativeMessaging() {
  const input = process.stdin;
  let buffer = Buffer.alloc(0);

  input.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 64 * 1024 * 1024) {
        writeNativeMessage({
          id: null,
          ok: false,
          error: {
            code: "message_too_large",
            statusCode: 413,
            message: "Native message too large",
          },
        });
        process.exit(1);
      }
      if (buffer.length < 4 + length) return;
      const raw = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        writeNativeMessage({
          id: null,
          ok: false,
          error: {
            code: "invalid_json",
            statusCode: 400,
            message: "Invalid native JSON message",
          },
        });
        continue;
      }
      writeNativeMessage(await handleNativeMessage(message));
    }
  });

  input.on("end", () => {
    process.exit(0);
  });

  process.stderr.write(`PrivCloud Companion native host ${VERSION} ready\n`);
}

async function handleHealth(req, res) {
  sendJson(res, 200, bridgeHealthPayload());
}

async function handleStartPairing(req, res) {
  const pairingId = crypto.randomUUID();
  const code = randomCode();
  const expiresAt = now() + PAIRING_TTL_MS;
  pendingPairings.set(pairingId, {
    codeHash: sha256(code),
    expiresAt,
    attempts: 0,
  });
  console.log("");
  console.log("PrivCloud Bridge pairing request");
  console.log(`  Code: ${code}`);
  console.log(`  Expires: ${new Date(expiresAt).toLocaleString()}`);
  console.log("");
  sendJson(res, 202, {
    pairingId,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

async function createBridgeToken(label) {
  const token = randomToken();
  const createdAt = new Date();
  state.tokens.push({
    id: crypto.randomUUID(),
    hash: sha256(token),
    label: typeof label === "string" ? label.slice(0, 80) : "PrivCloud web app",
    createdAt: createdAt.toISOString(),
    expiresAt:
      TOKEN_TTL_MS > 0
        ? new Date(createdAt.getTime() + TOKEN_TTL_MS).toISOString()
        : null,
    lastUsedAt: null,
  });
  pruneTokens();
  await saveState();
  return token;
}

async function handleCreateToken(req, res) {
  const body = await readJson(req);
  const token = await createBridgeToken(body.label);
  sendJson(res, 201, {
    token,
    bridgeId: state.bridgeId,
  });
}

async function handleConfirmPairing(req, res, pairingId) {
  const body = await readJson(req);
  const pending = pendingPairings.get(pairingId);
  if (!pending || pending.expiresAt < now()) {
    pendingPairings.delete(pairingId);
    const err = new Error("Pairing request expired");
    err.statusCode = 410;
    throw err;
  }
  pending.attempts += 1;
  if (
    pending.attempts > 5 ||
    !timingSafeHexEqual(pending.codeHash, sha256(String(body.code || "")))
  ) {
    if (pending.attempts > 5) pendingPairings.delete(pairingId);
    const err = new Error("Invalid pairing code");
    err.statusCode = 403;
    throw err;
  }

  pendingPairings.delete(pairingId);
  const token = await createBridgeToken(body.label);
  sendJson(res, 201, {
    token,
    bridgeId: state.bridgeId,
  });
}

async function handleWebDavList(req, res) {
  authenticate(req);
  const body = await readJson(req);
  const endpointUrl = directoryUrl(resolveWebDavHref(body.endpoint, body.href));
  const propfindBody =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop>' +
    "<d:displayname /><d:resourcetype /><d:getcontentlength />" +
    "<d:getcontenttype /><d:getlastmodified />" +
    "</d:prop></d:propfind>";

  const { response, target } = await webDavFetch({
    endpoint: body.endpoint,
    username: body.username,
    password: body.password,
    href: endpointUrl.href,
    method: "PROPFIND",
    body: propfindBody,
    headers: {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml,text/xml",
    },
  });
  const xml = await readLimitedText(response, MAX_PROPFIND_XML);
  sendJson(res, 200, {
    url: target.href,
    entries: parseWebDavMultiStatus(xml, target.href),
  });
}

async function handleWebDavDownload(req, res) {
  authenticate(req);
  const body = await readJson(req);
  const { response, target } = await webDavFetch({
    endpoint: body.endpoint,
    username: body.username,
    password: body.password,
    href: body.href,
    method: "GET",
  });
  const fileName = entryNameFromHref(target).replace(/[\r\n"]/g, "_");
  const headers = {
    "Content-Type":
      response.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const contentLength = response.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;
  res.writeHead(200, headers);
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

function createWebDavUploadJob(body, _origin) {
  cleanupJobs();
  const activeJobs = Array.from(jobs.values()).filter(
    (job) => !["completed", "failed", "cancelled"].includes(job.state),
  ).length;
  if (activeJobs >= MAX_ACTIVE_JOBS) {
    const err = new Error("Too many active Bridge jobs");
    err.statusCode = 429;
    err.code = "bridge_too_many_jobs";
    throw err;
  }

  const appBaseUrl = normalizePrivCloudBaseUrl(body.appBaseUrl);
  const shareId = String(body.shareId || "");
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(shareId)) {
    const err = new Error("Invalid share id");
    err.statusCode = 400;
    throw err;
  }
  const uploadToken = String(body.uploadToken || "");
  if (!uploadToken.startsWith("pcbu_")) {
    const err = new Error("Invalid upload token");
    err.statusCode = 400;
    throw err;
  }

  const chunkSize = Number(body.chunkSize);
  if (!Number.isFinite(chunkSize) || chunkSize < 1 || chunkSize > 200_000_000) {
    const err = new Error("Invalid chunk size");
    err.statusCode = 400;
    throw err;
  }

  if (
    !Array.isArray(body.files) ||
    body.files.length < 1 ||
    body.files.length > MAX_FILES_PER_JOB
  ) {
    const err = new Error(`Select between 1 and ${MAX_FILES_PER_JOB} files`);
    err.statusCode = 400;
    err.code = "bridge_file_selection_limit";
    throw err;
  }

  const files = body.files.map((file) => {
    const href = String(file.href || "");
    const size = Number(file.size);
    if (!href || !Number.isFinite(size) || size < 0) {
      const err = new Error("Invalid WebDAV file selection");
      err.statusCode = 400;
      throw err;
    }
    return {
      href,
      name: sanitizeFileName(file.name),
      size,
      contentType:
        typeof file.contentType === "string" ? file.contentType : undefined,
      lastModified:
        typeof file.lastModified === "string" ? file.lastModified : undefined,
    };
  });

  const payload = {
    appBaseUrl,
    shareId,
    uploadToken,
    chunkSize,
    encryptionKey: body.isE2EEncrypted
      ? decodeBase64UrlKey(body.encryptionKey)
      : null,
    webdav: {
      endpoint: body.webdav?.endpoint,
      username: body.webdav?.username,
      password: body.webdav?.password,
    },
    files,
  };

  normalizeWebDavUrl(
    payload.webdav.endpoint,
    process.env.PRIVCLOUD_BRIDGE_ALLOW_HTTP_WEBDAV === "1",
  );
  if (!payload.webdav.username || !payload.webdav.password) {
    const err = new Error("WebDAV username and password are required");
    err.statusCode = 400;
    throw err;
  }

  const job = {
    id: crypto.randomUUID(),
    state: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    uploadedBytes: 0,
    completedFiles: 0,
    currentFileName: null,
    error: null,
    cancelled: false,
    abortController: new AbortController(),
    files: files.map((file) => ({
      name: file.name,
      size: file.size,
      state: "queued",
      uploadedBytes: 0,
      error: null,
    })),
  };

  jobs.set(job.id, job);
  void runWebDavUploadJob(job, payload);
  return publicJob(job);
}

async function handleCreateWebDavUploadJob(req, res) {
  authenticate(req);
  const body = await readJson(req);
  sendJson(res, 202, createWebDavUploadJob(body, req.headers.origin));
}

async function handleGetJob(req, res, jobId) {
  authenticate(req);
  const job = jobs.get(jobId);
  if (!job) {
    const err = new Error("Bridge job not found");
    err.statusCode = 404;
    err.code = "job_not_found";
    throw err;
  }
  sendJson(res, 200, publicJob(job));
}

async function handleCancelJob(req, res, jobId) {
  authenticate(req);
  const job = jobs.get(jobId);
  if (!job) {
    const err = new Error("Bridge job not found");
    err.statusCode = 404;
    err.code = "job_not_found";
    throw err;
  }
  if (!["completed", "failed", "cancelled"].includes(job.state)) {
    job.cancelled = true;
    job.abortController.abort();
    job.state = "cancelled";
    job.error = "Job cancelled";
    touchJob(job);
  }
  sendJson(res, 200, publicJob(job));
}

async function route(req, res) {
  assertLoopbackPeer(req);
  setCommonHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  assertOrigin(req);
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/v1/health") {
    await handleHealth(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/pairings") {
    await handleStartPairing(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/tokens") {
    await handleCreateToken(req, res);
    return;
  }
  const pairingMatch = /^\/v1\/pairings\/([^/]+)\/confirm$/.exec(url.pathname);
  if (req.method === "POST" && pairingMatch) {
    await handleConfirmPairing(req, res, pairingMatch[1]);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/webdav/list") {
    await handleWebDavList(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/webdav/download") {
    await handleWebDavDownload(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/jobs/webdav-upload") {
    await handleCreateWebDavUploadJob(req, res);
    return;
  }
  const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && jobMatch) {
    await handleGetJob(req, res, jobMatch[1]);
    return;
  }
  const jobCancelMatch = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (req.method === "POST" && jobCancelMatch) {
    await handleCancelJob(req, res, jobCancelMatch[1]);
    return;
  }

  const err = new Error("Not found");
  err.statusCode = 404;
  throw err;
}

function cleanupPairings() {
  const cutoff = now();
  for (const [id, pending] of pendingPairings) {
    if (pending.expiresAt < cutoff) pendingPairings.delete(id);
  }
}

await loadState();
setInterval(cleanupJobs, 60_000).unref();

if (process.argv.includes("--native-messaging")) {
  await runNativeMessaging();
} else {
  assertLoopbackBindHost(HOST);
  setInterval(cleanupPairings, 30_000).unref();

  // This endpoint is deliberately HTTP on a literal loopback address. Browser
  // trust stores reject ad-hoc localhost certificates, so self-signed TLS would
  // break the web integration without authenticating the Companion. The bind
  // and every accepted peer are both restricted to loopback; exact Origin
  // validation and bearer authentication protect application operations.
  const server = createLoopbackHttpServer((req, res) => {
    route(req, res).catch((err) => sendError(res, err));
  });

  server.listen(PORT, HOST, () => {
    console.log(`PrivCloud Companion ${VERSION}`);
    console.log(`Listening on http://${HOST}:${PORT}`);
    console.log(`Bridge ID: ${state.bridgeId}`);
    console.log(`Native host: ${NATIVE_HOST_NAME}`);
    console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ")}`);
    console.log("No WebDAV credentials are persisted.");
  });
}
