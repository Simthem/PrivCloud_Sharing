import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const page = Buffer.from("encrypted synthetic rendered page");
const run = promisify(execFile);
async function fixture(mode, callback) {
  const directory = await mkdtemp(join(tmpdir(), "privcloud-read-only-https-"));
  let server,
    requests = 0;
  try {
    const key = join(directory, "key.pem"),
      cert = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=Read-only local HTTPS test",
        "-addext",
        mode === "wrong-host"
          ? "subjectAltName=IP:127.0.0.2"
          : "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore", timeout: 15000 },
    );
    await chmod(key, 0o600);
    server = createServer(
      {
        key: await readFile(key),
        cert: await readFile(cert),
        minVersion: "TLSv1.2",
      },
      (req, res) => {
        requests++;
        res.setHeader("Content-Type", "application/json");
        const owner = req.headers.cookie === "session=owner-test";
        const contractor = req.headers.cookie === "session=contractor-test";
        if (mode === "redirect") {
          res.writeHead(302, { Location: "https://off-fixture.invalid/" });
          res.end();
          return;
        }
        if (req.url === "/api/shares/share/files/file" && owner) {
          res.writeHead(206, {
            "Content-Range": "bytes 0-0/10",
            "Content-Type": "application/octet-stream",
          });
          res.end("x");
          return;
        }
        if (req.url === "/api/external/previews/own" && contractor) {
          if (mode === "html" || mode === "html-mixed-case") {
            res.setHeader(
              "Content-Type",
              mode === "html-mixed-case"
                ? "Text/HTML; Charset=UTF-8"
                : "text/html",
            );
            res.end("<html>WAF challenge</html>");
          } else
            res.end(
              JSON.stringify({
                id: "own",
                encryptedManifest: "fixture-ciphertext",
              }),
            );
          return;
        }
        if (req.url === "/api/external/previews/own/pages/0" && contractor) {
          res.setHeader("Content-Type", "application/octet-stream");
          res.end(mode === "changed-page" ? Buffer.from("tampered") : page);
          return;
        }
        if (
          mode === "open-original" &&
          req.url === "/api/shares/share/files/file" &&
          contractor
        ) {
          res.end("exposed original");
          return;
        }
        res.writeHead(owner || contractor ? 404 : 401);
        res.end("{}");
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const config = {
      origin: `https://127.0.0.1:${server.address().port}`,
      teamId: "team",
      shareId: "share",
      fileId: "file",
      previewId: "own",
      revokedPreviewId: "revoked",
      expiredPreviewId: "expired",
      otherPreviewId: "other",
      pageCipherSha256: createHash("sha256").update(page).digest("hex"),
      ownerHeaders: { Cookie: "session=owner-test" },
      contractorHeaders: { Cookie: "session=contractor-test" },
    };
    const audit = async (input = config, { trusted = true, mode = 0o600 } = {}) => {
      const configPath = join(directory, "private-test-config.json");
      await writeFile(configPath, JSON.stringify(input), { mode: 0o600 });
      await chmod(configPath, mode);
      // Trust this ephemeral certificate only inside the CLI child process.
      // Certificate/hostname verification remain enabled. No trust store is changed.
      const env = { ...process.env, NODE_USE_ENV_PROXY: "0", NODE_OPTIONS: "" };
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      delete env.NODE_EXTRA_CA_CERTS;
      if (trusted) env.NODE_EXTRA_CA_CERTS = cert;
      const { stdout } = await run(
        process.execPath,
        [
          fileURLToPath(new URL("../read-only.mjs", import.meta.url)),
          "private-test-config.json",
        ],
        { cwd: directory, env, timeout: 30000, maxBuffer: 65536 },
      );
      return JSON.parse(stdout);
    };
    await callback({ config, audit, requests: () => requests });
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
}
test("HTTPS audit uses owner positive control and checks original/key/seat denials", () =>
  fixture("valid", async ({ audit }) => {
    const r = await audit();
    assert.equal(r.checks.length, 16);
  }));
for (const mode of ["html", "html-mixed-case", "changed-page", "open-original"])
  test("HTTPS audit rejects " + mode, () =>
    fixture(mode, async ({ audit }) => {
      await assert.rejects(audit());
    }),
  );
test("HTTPS audit rejects redirects without contacting another origin", () =>
  fixture("redirect", async ({ audit, requests }) => {
    await assert.rejects(audit(), /unexpected HTTP 302/);
    assert.equal(requests(), 1);
  }));
test("HTTPS audit rejects an untrusted TLS certificate", () =>
  fixture("valid", async ({ audit, config, requests }) => {
    await assert.rejects(audit(config, { trusted: false }));
    assert.equal(requests(), 0);
  }));
test("HTTPS audit verifies the certificate hostname", () =>
  fixture("wrong-host", async ({ audit, requests }) => {
    await assert.rejects(audit());
    assert.equal(requests(), 0);
  }));
test("HTTPS audit rejects a cleartext origin before transmitting sessions", () =>
  fixture("valid", async ({ audit, config, requests }) => {
    await assert.rejects(
      audit({ ...config, origin: config.origin.replace("https:", "http:") }),
      /HTTPS is required/,
    );
    assert.equal(requests(), 0);
  }));
test("HTTPS audit rejects the same session with differently cased header names", () =>
  fixture("valid", async ({ audit, config, requests }) => {
    await assert.rejects(
      audit({
        ...config,
        contractorHeaders: { cookie: config.ownerHeaders.Cookie },
      }),
      /two distinct authenticated sessions/,
    );
    assert.equal(requests(), 0);
  }));
test("HTTPS audit refuses a configuration readable by other local users", () =>
  fixture("valid", async ({ audit, config, requests }) => {
    if (process.platform === "win32") return;
    await assert.rejects(
      audit(config, { mode: 0o644 }),
      /chmod 600/,
    );
    assert.equal(requests(), 0);
  }));
