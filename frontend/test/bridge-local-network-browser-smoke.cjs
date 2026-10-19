const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { once } = require("node:events");
const {
  createHash,
  randomBytes,
  X509Certificate,
  createDecipheriv,
} = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");
const ts = require("../node_modules/typescript");
const WebSocket = require("../node_modules/next/dist/compiled/ws");

const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "privcloud-native-browser-"),
);
let app, browser, protocolSocket;

async function main() {
  const key = path.join(fixture, "key.pem");
  const cert = path.join(fixture, "cert.pem");
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
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore", timeout: 15000 },
  );
  const certificate = fs.readFileSync(cert);
  const pin = createHash("sha256")
    .update(
      new X509Certificate(certificate).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  const file = randomBytes(2 * 1024 * 1024 + 7);
  const fileHash = createHash("sha256").update(file).digest("hex");
  const uploadKey = randomBytes(32);
  const uploadToken = "pcbu_" + randomBytes(32).toString("base64url");
  const encryptedChunks = [];
  let webdavRequests = 0;
  function compileService(name) {
    return ts.transpileModule(
      fs.readFileSync(
        path.resolve(__dirname, "../src/services", name + ".service.ts"),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
  }
  const bridgeModule = compileService("privcloudBridge");
  const companionModule = compileService("privcloudCompanion");
  const androidModule = compileService("bridgeAndroidLoopback");
  app = https.createServer(
    { key: fs.readFileSync(key), cert: certificate, minVersion: "TLSv1.2" },
    async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      const installAssets = {
        "/install/companion/privcloud-companion.mjs":
          "bridge/src/privcloud-bridge.mjs",
        "/install/companion/direct-upload.mjs": "bridge/src/direct-upload.mjs",
        "/install/companion/native-transport.mjs":
          "bridge/src/native-transport.mjs",
        "/install/companion/install/linux/register-native-messaging.sh":
          "bridge/install/linux/register-native-messaging.sh",
      };
      if (Object.hasOwn(installAssets, req.url)) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(
          fs.readFileSync(
            path.resolve(__dirname, "../..", installAssets[req.url]),
          ),
        );
        return;
      }
      if (req.url?.startsWith("/api/shares/native-test/files/bridge?")) {
        assert.equal(req.headers.authorization, "Bearer " + uploadToken);
        const id = new URL(req.url, "https://fixture.invalid").searchParams.get(
          "id",
        );
        if (
          !id ||
          id.length !== 36 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            id,
          )
        ) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end('{"error":"Invalid fixture file identifier"}');
          return;
        }
        assert.equal(
          decodeURIComponent(req.headers["x-file-name"]),
          `encrypted-file-${id.slice(0, 8)}`,
        );
        const metadata = Buffer.from(
          req.headers["x-file-metadata"],
          "base64url",
        );
        const label = createDecipheriv(
          "aes-256-gcm",
          uploadKey,
          metadata.subarray(0, 12),
        );
        label.setAuthTag(metadata.subarray(-16));
        label.setAAD(Buffer.from(`privcloud:file-meta:v1:native-test:${id}`));
        assert.deepEqual(
          JSON.parse(
            Buffer.concat([
              label.update(metadata.subarray(12, -16)),
              label.final(),
            ]).toString(),
          ),
          { v: 1, n: "item.bin" },
        );
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          uploadKey,
          bytes.subarray(0, 12),
        );
        decipher.setAuthTag(bytes.subarray(bytes.length - 16));
        encryptedChunks.push(
          Buffer.concat([
            decipher.update(bytes.subarray(12, -16)),
            decipher.final(),
          ]),
        );
        res.writeHead(201, { "Content-Type": "application/json" });
        // JSON stays safe even if embedded in HTML by a future fixture consumer.
        res.end(
          JSON.stringify({ id })
            .replace(/</g, "\\u003c")
            .replace(/>/g, "\\u003e")
            .replace(/&/g, "\\u0026"),
        );
        return;
      }
      switch (req.url) {
        case "/privcloudBridge.service":
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
          res.end(bridgeModule);
          return;
        case "/bridgeAndroidLoopback.service":
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
          res.end(androidModule);
          return;
        case "/privcloudCompanion.service":
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
          res.end(companionModule);
          return;
        case "/dav/":
          webdavRequests++;
          res.writeHead(207, {
            "Content-Type": "application/xml; charset=utf-8",
          });
          res.end(
            '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/item.bin</d:href><d:propstat><d:prop><d:displayname>item.bin</d:displayname><d:getcontentlength>2097159</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
          );
          return;
        case "/dav/item.bin":
          webdavRequests++;
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(file.length),
          });
          res.end(file);
          return;
        case "/fixture.js":
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
          res.end(
            'import * as bridge from "/privcloudBridge.service"; window.bridge = bridge;',
          );
          return;
        case "/":
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            '<!doctype html><script type="module" src="/fixture.js"></script>',
          );
          return;
        case "/favicon.ico":
          res.writeHead(204);
          res.end();
          return;
        default:
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
      }
    },
  );
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const origin = `https://127.0.0.1:${app.address().port}`;
  // Exercise the actual route before starting Chrome. Rejected input must never
  // appear in a response body, including encoded HTML and malformed identifiers.
  for (const maliciousId of [
    "<script>alert(1)</script>",
    "not-a-uuid",
    "00000000-0000-4000-8000-000000000000\n",
  ]) {
    const rejected = await new Promise((resolve, reject) => {
      const request = https.get(
        origin +
          "/api/shares/native-test/files/bridge?id=" +
          encodeURIComponent(maliciousId),
        {
          ca: certificate,
          headers: { Authorization: "Bearer " + uploadToken },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              type: response.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.type, "application/json; charset=utf-8");
    assert.equal(rejected.body, '{"error":"Invalid fixture file identifier"}');
  }
  const extension = path.join(fixture, "extension");
  fs.cpSync(
    path.resolve(__dirname, "../../integrations/browser-extension"),
    extension,
    { recursive: true },
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extension, "manifest.json")),
  );
  manifest.content_scripts = [
    {
      matches: [origin + "/*"],
      js: ["src/page-bridge.js"],
      run_at: "document_start",
    },
  ];
  manifest.host_permissions = [origin + "/*"];
  delete manifest.browser_specific_settings;
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
  const backgroundPath = path.join(extension, "src/background.js");
  fs.writeFileSync(
    backgroundPath,
    fs
      .readFileSync(backgroundPath, "utf8")
      .replace(
        /const DEFAULT_APP_URL = "[^"]+";/,
        `const DEFAULT_APP_URL = ${JSON.stringify(origin)};`,
      ),
  );
  const home = path.join(fixture, "home");
  const flatpakApp = process.env.CHROME_FLATPAK;
  if (flatpakApp && flatpakApp !== "org.chromium.Chromium")
    throw new Error(
      "This fixture supports the installed org.chromium.Chromium Flatpak.",
    );
  const configHome = flatpakApp
    ? path.join(home, ".var/app/org.chromium.Chromium/config")
    : path.join(home, ".config");
  const profile = path.join(
    configHome,
    flatpakApp ? "chromium" : "google-chrome",
  );
  fs.mkdirSync(profile, { recursive: true });
  // Chrome requires a separate user data directory for remote debugging.
  const browserProfile = flatpakApp
    ? profile
    : path.join(fixture, "browser-profile");
  const browserArgs = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-networking",
    "--enable-unsafe-extension-debugging",
    flatpakApp ? "--remote-debugging-port=0" : "--remote-debugging-pipe",
    `--ignore-certificate-errors-spki-list=${pin}`,
    `--user-data-dir=${browserProfile}`,
    `--ip-address-space-overrides=127.0.0.1:${app.address().port}=public`,
    "about:blank",
  ];
  browser = spawn(
    flatpakApp
      ? "flatpak"
      : process.env.CHROME_BIN || "/opt/google/chrome/google-chrome",
    flatpakApp
      ? [
          "run",
          `--filesystem=${fixture}`,
          `--env=HOME=${home}`,
          `--env=XDG_CONFIG_HOME=${configHome}`,
          `--env=XDG_CACHE_HOME=${path.join(fixture, "cache")}`,
          `--env=NODE_EXTRA_CA_CERTS=${cert}`,
          `--env=PRIVCLOUD_BRIDGE_STATE_DIR=${path.join(fixture, "state")}`,
          "--env=NODE_OPTIONS=",
          flatpakApp,
          ...browserArgs,
        ]
      : browserArgs,
    {
      env: {
        ...process.env,
        ...(flatpakApp ? {} : { HOME: home, XDG_CONFIG_HOME: configHome }),
        NODE_OPTIONS: "",
        NODE_EXTRA_CA_CERTS: cert,
        PRIVCLOUD_BRIDGE_STATE_DIR: path.join(fixture, "state"),
      },
      stdio: flatpakApp
        ? ["ignore", "ignore", "pipe"]
        : ["ignore", "ignore", "pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map(),
    errors = [],
    issues = [],
    network = [],
    failures = [];
  let browserStderr = "";
  browser.stderr.on("data", (chunk) => {
    browserStderr = (browserStderr + chunk).slice(-8000);
  });
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  for (const pipe of flatpakApp ? [] : [browser.stdio[3], browser.stdio[4]])
    pipe.on("error", (error) =>
      rejectPending(
        new Error(`Browser pipe failed: ${error.message}\n${browserStderr}`),
      ),
    );
  browser.on("error", rejectPending);
  browser.on("exit", (code) =>
    rejectPending(new Error(`Browser exited (${code}): ${browserStderr}`)),
  );
  let nextId = 0;
  const handleProtocolPacket = (message) => {
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails.text);
    if (
      message.method === "Log.entryAdded" &&
      message.params.entry.level === "error"
    )
      errors.push(message.params.entry.text);
    if (message.method === "Audits.issueAdded")
      issues.push(message.params.issue);
    if (message.method === "Network.loadingFailed")
      failures.push(message.params.errorText);
    if (message.method === "Network.requestWillBeSent")
      network.push(message.params.request.url);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error
      ? entry.reject(new Error(message.error.message))
      : entry.resolve(message.result);
  };
  let send;
  if (flatpakApp) {
    // flatpak run on older distributions does not forward arbitrary pipe FDs.
    // CDP's temporary loopback socket is only used by this Node test harness.
    let endpoint;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (browser.exitCode !== null) throw new Error(browserStderr);
      try {
        const [port, url] = fs
          .readFileSync(path.join(profile, "DevToolsActivePort"), "utf8")
          .trim()
          .split("\n");
        assert.match(port, /^[0-9]{1,5}$/);
        assert.match(url, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
        endpoint = `ws://127.0.0.1:${port}${url}`;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!endpoint)
      throw new Error(`No Flatpak debugging endpoint: ${browserStderr}`);
    protocolSocket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      protocolSocket.once("open", resolve);
      protocolSocket.once("error", reject);
    });
    // Node's socket events are bound to this validated CDP endpoint. They are
    // not window messages and cannot be dispatched by a web page.
    protocolSocket.on("message", (data, binary) => {
      if (protocolSocket.url !== endpoint || binary) {
        rejectPending(new Error("Unexpected browser debugging channel"));
        return;
      }
      try {
        handleProtocolPacket(JSON.parse(data.toString("utf8")));
      } catch (error) {
        rejectPending(error);
      }
    });
    protocolSocket.on("error", rejectPending);
    protocolSocket.on("close", () =>
      rejectPending(new Error("Browser debugging connection closed")),
    );
    send = (message) => protocolSocket.send(JSON.stringify(message));
  } else send = createChromeProtocolPipe(browser, handleProtocolPacket);
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("CDP timeout: " + method + "\n" + browserStderr));
      }, 90_000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params, sessionId });
    });
  const { targetId } = await call("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  for (const domain of ["Runtime", "Page", "Log", "Audits", "Network"])
    await call(domain + ".enable", {}, sessionId);
  const evaluate = async (expression) => {
    const result = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const callPageFunction = async (functionDeclaration, argumentsList = []) => {
    const globalObject = await call(
      "Runtime.evaluate",
      { expression: "globalThis", returnByValue: false },
      sessionId,
    );
    const result = await call(
      "Runtime.callFunctionOn",
      {
        objectId: globalObject.result.objectId,
        functionDeclaration,
        arguments: argumentsList.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  await call("Browser.setPermission", {
    permission: { name: "loopback-network" },
    setting: "denied",
    origin,
  });
  await call("Page.navigate", { url: origin }, sessionId);
  for (let i = 0; i < 100 && !(await evaluate("!!window.bridge")); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await evaluate("bridge.getBridgeHealth()"), null);
  assert.equal(
    await evaluate(
      "bridge.getBridgeHealth({requestLocalAccess:true}).catch(e=>e.message)",
    ),
    "bridge.error.extensionRequired",
  );
  const loaded = await call("Extensions.loadUnpacked", { path: extension });
  // Exercise the shipped curl installer and registration helper, not a
  // hand-written host manifest. Do not start the legacy HTTP background service.
  const installerBin = path.join(fixture, "installer-bin");
  fs.mkdirSync(installerBin);
  for (const command of ["pkill", "nohup", "systemctl"])
    fs.writeFileSync(path.join(installerBin, command), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
  const installer = fs.existsSync(
    path.resolve(
      __dirname,
      "../../frontend/public/install/companion/install-linux-dev.sh",
    ),
  )
    ? path.resolve(
        __dirname,
        "../../frontend/public/install/companion/install-linux-dev.sh",
      )
    : path.resolve(__dirname, "../../bridge/install/install-linux-dev.sh");
  const installerResult = await execFile("sh", [installer], {
    timeout: 15000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PATH: installerBin + ":" + process.env.PATH,
      CURL_CA_BUNDLE: cert,
      NODE_OPTIONS: "",
      PRIVCLOUD_BASE_URL: origin,
      PRIVCLOUD_CHROME_EXTENSION_ID: loaded.id,
      PRIVCLOUD_BRIDGE_STATE_DIR: path.join(fixture, "state"),
    },
  });
  assert.match(installerResult.stdout, /native messaging host registered/);
  const registered = JSON.parse(
    fs.readFileSync(
      path.join(profile, "NativeMessagingHosts/fr.privcloud.companion.json"),
    ),
  );
  assert.equal(
    registered.path,
    path.join(home, ".local/bin/privcloud-companion"),
  );
  if (!flatpakApp) {
    // Native host lookup follows the temporary debugging profile on Chrome.
    const hosts = path.join(browserProfile, "NativeMessagingHosts");
    fs.mkdirSync(hosts, { recursive: true });
    fs.copyFileSync(
      path.join(profile, "NativeMessagingHosts/fr.privcloud.companion.json"),
      path.join(hosts, "fr.privcloud.companion.json"),
    );
  }
  await call("Page.reload", {}, sessionId);
  for (let i = 0; i < 100 && !(await evaluate("!!window.bridge")); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const health = await evaluate(
    "bridge.getBridgeHealth({requestLocalAccess:true})",
  );
  assert.equal(health.name, "PrivCloud Companion");
  assert.equal(health.nativeTransportVersion, 1);
  await evaluate("bridge.authorizeBridge()");
  const credentials = {
    endpoint: origin + "/dav/",
    username: "fixture",
    password: randomBytes(24).toString("base64url"),
  };
  const entries = await callPageFunction(
    "async function(credentials) { return (await this.bridge.listWebDavDirectoryViaBridge(credentials)).entries; }",
    [credentials],
  );
  assert.equal(entries[0].name, "item.bin");
  const digest = await callPageFunction(
    "async function(credentials, entry) { const file = await this.bridge.downloadWebDavFileViaBridge(credentials, entry); const hash = await this.crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return { size: file.size, hash: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') }; }",
    [credentials, entries[0]],
  );
  assert.deepEqual(digest, { size: file.length, hash: fileHash });
  const payload = {
    appBaseUrl: origin,
    shareId: "native-test",
    uploadToken,
    chunkSize: 1_000_000,
    isE2EEncrypted: true,
    encryptionKey: uploadKey.toString("base64url"),
    fileMetadataScheme: 1,
    webdav: credentials,
    files: entries,
  };
  const job = await callPageFunction(
    "function(payload) { return this.bridge.startBridgeWebDavUploadJob(payload); }",
    [payload],
  );
  const finished = await callPageFunction(
    "function(jobId) { return this.bridge.waitForBridgeUploadJob(jobId, { pollIntervalMs: 50 }); }",
    [job.id],
  );
  assert.equal(finished.state, "completed");
  assert.equal(finished.completedFiles, 1);
  assert.deepEqual(
    Buffer.concat(encryptedChunks),
    file,
    "Every upload chunk decrypts to the original bytes",
  );
  assert.equal(encryptedChunks.length, 3);
  const cancellation = await callPageFunction(
    "async function(payload) { const job = await this.bridge.startBridgeWebDavUploadJob(payload); return this.bridge.cancelBridgeUploadJob(job.id); }",
    [payload],
  );
  assert.equal(cancellation.state, "cancelled");
  assert.equal(
    (await evaluate("bridge.getBridgeHealth()")).bridgeId,
    health.bridgeId,
  );
  for (const setting of ["granted", "denied"]) {
    await call("Browser.setPermission", {
      permission: { name: "loopback-network" },
      setting,
      origin,
    });
    assert.equal(
      (await evaluate("bridge.getBridgeHealth()")).bridgeId,
      health.bridgeId,
    );
  }
  assert.ok(webdavRequests >= 3);
  assert.deepEqual(
    network.filter((url) =>
      /\/v1\/|\/dav\/|\/files\/bridge/.test(new URL(url).pathname),
    ),
    [],
    "WebDAV and Companion traffic never originate from the page",
  );
  assert.deepEqual(errors, [], "Zero console errors");
  assert.deepEqual(failures, [], "Zero browser network failures");
  assert.deepEqual(issues, [], "Zero DevTools audits, without filtering");
  console.log(
    `Native Messaging + curl installer${flatpakApp ? " + Flatpak" : ""} (${(await call("Browser.getVersion")).product}): health, authorization, 2 MiB download, encrypted upload/poll/cancel passed; zero browser loopback requests, console errors or DevTools audits.`,
  );
  await call("Extensions.uninstall", { id: loaded.id });
  await call("Browser.close").catch(() => undefined);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    protocolSocket?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, "exit");
      browser.kill("SIGTERM");
      await exited;
    }
    for (const stream of browser?.stdio || []) stream?.destroy?.();
    if (app?.listening) {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  });
