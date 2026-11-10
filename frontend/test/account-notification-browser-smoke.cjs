const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { once } = require("node:events");
const { spawn, execFileSync } = require("node:child_process");
const { createHash, X509Certificate } = require("node:crypto");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");
const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(__dirname, "fixtures/account-notifications");
const output =
  process.env.ACCOUNT_NOTIFICATION_TEST_DIRECTORY ||
  "/tmp/privcloud-account-notifications";
let server, browser;
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const compiled = require(
    path.join(root, "node_modules/next/dist/compiled/webpack/webpack"),
  );
  const webpack = compiled.webpack;
  const compiler = webpack({
    mode: "development",
    target: "web",
    devtool: false,
    entry: path.join(fixtureRoot, "entry.jsx"),
    output: { path: output, filename: "bundle.js" },
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs"],
      modules: [path.join(root, "node_modules")],
    },
    module: {
      rules: [
        {
          test: /\.(?:tsx?|jsx)$/,
          exclude: /node_modules/,
          use: [
            { loader: path.join(__dirname, "browser-typescript-loader.cjs") },
          ],
        },
        {
          test: /\.css$/,
          use: [{ loader: path.join(fixtureRoot, "css-loader.cjs") }],
        },
      ],
    },
    plugins: [
      new webpack.DefinePlugin({
        "process.env.BUILD_TARGET": JSON.stringify("web"),
        "process.env.NEXT_PUBLIC_API_ORIGIN": JSON.stringify(""),
      }),
      new webpack.NormalModuleReplacementPlugin(
        /(?:config\.hook|user\.service|api\.service|toast\.util)$/,
        (resource) => {
          const name = resource.request.endsWith("config.hook")
            ? "config"
            : resource.request.endsWith("user.service")
              ? "users"
              : resource.request.endsWith("api.service")
                ? "api"
                : "toast";
          resource.request = path.join(fixtureRoot, name + ".js");
        },
      ),
    ],
    performance: { hints: false },
  });
  await new Promise((resolve, reject) =>
    compiler.run((error, stats) => {
      compiler.close(() => {});
      if (error || stats.hasErrors())
        reject(
          error || new Error(stats.toString({ all: false, errors: true })),
        );
      else resolve();
    }),
  );
  const bundle = fs.readFileSync(path.join(output, "bundle.js"));
  const cssFile = path.join(root, "src/styles/mantine-used.css");
  const css = fs.existsSync(cssFile)
    ? fs
        .readFileSync(cssFile, "utf8")
        .replace(
          /@import "(@mantine\/core\/styles\/[A-Za-z]+\.css)";/g,
          (_all, file) =>
            fs.readFileSync(path.join(root, "node_modules", file), "utf8"),
        )
    : fs.readFileSync(
        path.join(root, "node_modules/@mantine/core/styles.css"),
        "utf8",
      );
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
      path.join(output, "key.pem"),
      "-out",
      path.join(output, "cert.pem"),
    ],
    { stdio: "ignore", timeout: 15000 },
  );
  const cert = fs.readFileSync(path.join(output, "cert.pem"));
  const pin = createHash("sha256")
    .update(
      new X509Certificate(cert).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  const oss = !fs.existsSync(path.join(root, "../backend/src/stripe"));
  let fixture;
  const calls = [];
  server = https.createServer(
    { key: fs.readFileSync(path.join(output, "key.pem")), cert },
    (req, res) => {
      if (req.url === "/bundle.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bundle);
        return;
      }
      if (req.url === "/styles.css") {
        res.setHeader("Content-Type", "text/css");
        res.end(css);
        return;
      }
      if (req.url === "/account") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body style="margin:0;background:#141517"><div id="root"></div><script>window.__pushFixture=' +
            JSON.stringify(fixture).replace(/</g, "\\u003c") +
            '</script><script src="/bundle.js"></script></body></html>',
        );
        return;
      }
      if (req.url === "/api/users/me" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(fixture.user));
        return;
      }
      if (["/api/users/me", "/api/push/subscribe"].includes(req.url)) {
        let body = "";
        req.on("data", (part) => {
          body += part;
          if (body.length > 4096) req.destroy();
        });
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          calls.push({ method: req.method, path: req.url, payload });
          if (req.url === "/api/users/me") Object.assign(fixture.user, payload);
          else fixture.subscribed = req.method === "POST";
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(req.url === "/api/users/me" ? fixture.user : {}),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "https://127.0.0.1:" + server.address().port;
  await new Promise((resolve, reject) =>
    https
      .get(origin + "/styles.css", { ca: cert }, (res) => {
        assert.equal(res.statusCode, 200);
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject),
  );
  browser = spawn(
    process.env.CHROME_BIN || "/opt/google/chrome/chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--user-data-dir=" + path.join(output, "profile"),
      "--ignore-certificate-errors-spki-list=" + pin,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  browser.stderr.on("data", () => {});
  const send = createChromeProtocolPipe(
    browser,
    (message) => {
      if (message.id) {
        const operation = pending.get(message.id);
        if (!operation) return;
        pending.delete(message.id);
        clearTimeout(operation.timer);
        message.error
          ? operation.reject(new Error(JSON.stringify(message.error)))
          : operation.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown")
        errors.push(
          message.params.exceptionDetails.text +
            ": " +
            (message.params.exceptionDetails.exception?.description || ""),
        );
    },
    (error) => {
      for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(error);
      }
      pending.clear();
    },
  );
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Protocol timeout: " + method));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  const target = await call("Target.createTarget", { url: "about:blank" });
  const attached = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sid = attached.sessionId;
  await call("Page.enable", {}, sid);
  await call("Runtime.enable", {}, sid);
  const evaluate = async (expression) => {
    const result = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sid,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let n = 0; n < 120; n++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Browser condition timed out: " + expression);
  };
  const click = async (selector) => {
    const point = await evaluate(
      `(()=>{const item=document.querySelector(${JSON.stringify(selector)});if(!item)return null;const rect=item.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`,
    );
    assert.ok(point, selector);
    await call(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, ...point },
      sid,
    );
    await call(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, ...point },
      sid,
    );
  };
  const visible = (selector) =>
    `(()=>{const item=document.querySelector(${JSON.stringify(selector)});return !!item && item.getBoundingClientRect().height>0 && getComputedStyle(item).visibility!=='hidden';})()`;
  const capture = async (name) => {
    const image = await call(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true },
      sid,
    );
    fs.writeFileSync(
      path.join(output, name + ".png"),
      Buffer.from(image.data, "base64"),
    );
    if (process.env.ACCOUNT_NOTIFICATION_EXPORT_SCREENSHOTS === "1")
      console.log(
        "SCREENSHOT_JSON " + JSON.stringify({ name, data: image.data }),
      );
  };
  for (const width of [1154, 390]) {
    fixture = {
      permission: "granted",
      subscribed: false,
      user: {
        id: "subscriber",
        username: "fixture",
        signaturePushEligible: true,
        signaturePushEnabled: false,
        hasTeamMembership: false,
        notificationMode: "DIGEST",
        ...(oss ? {} : { plan: "TEAM" }),
      },
    };
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width, height: 820, deviceScaleFactor: 1, mobile: width < 600 },
      sid,
    );
    await call("Page.navigate", { url: origin + "/account" }, sid);
    await wait(
      'document.querySelector("[data-testid=account-push-settings] button") !== null',
    );
    assert.equal(
      await evaluate('document.querySelectorAll(".mantine-Paper-root").length'),
      1,
    );

    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".mantine-Paper-root")).borderTopWidth',
      ),
      "1px",
      "Actual Mantine panel styling is loaded",
    );

    assert.equal(
      await evaluate(visible("[data-testid=signature-push-preference]")),
      false,
    );
    await capture("account-notifications-" + width + "-disabled");
    await click("[data-testid=account-push-settings] button");
    await wait(visible("[data-testid=signature-push-preference]"));
    await wait(
      'document.querySelector("[data-testid=account-push-settings] button").getAttribute("aria-expanded")==="true"',
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      await evaluate('document.querySelectorAll(".mantine-Paper-root").length'),
      1,
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".mantine-Switch-track").getBoundingClientRect().width >= 30',
      ),
      true,
      "Switch stylesheet is loaded",
    );
    assert.equal(
      await evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
      "No horizontal overflow",
    );
    await capture("account-notifications-" + width + "-enabled");
    await click("[data-testid=signature-push-preference] label");
    await wait(
      'document.querySelector("[data-testid=signature-push-preference] input").checked',
    );
    await click("input[value=WEEKLY]");
    await wait('document.querySelector("input[value=WEEKLY]").checked');
    assert.equal(fixture.user.signaturePushEnabled, true);
    assert.equal(fixture.user.notificationMode, "WEEKLY");
    await call("Page.reload", {}, sid);
    await wait(
      'document.querySelector("[data-testid=signature-push-preference] input")?.checked === true',
    );
    assert.equal(
      await evaluate('document.querySelector("input[value=WEEKLY]").checked'),
      true,
    );
    await click("[data-testid=account-push-settings] button");
    await wait(
      'document.querySelector("[data-testid=account-push-settings] button").getAttribute("aria-expanded")==="false"',
    );
    assert.equal(
      fixture.user.signaturePushEnabled,
      true,
      "Disabling this device preserves account choices",
    );
    console.log(
      "PASS: real account notification panel at " +
        width +
        "px, one frame, collapsed/expanded layout, styled switch, persisted choices and reload",
    );
  }
  assert.ok(
    calls.some(
      (call) =>
        call.path === "/api/users/me" &&
        call.payload.signaturePushEnabled === true,
    ),
  );
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(
    "PASS: " +
      (oss
        ? "OSS account without a team or billing fields"
        : "Team subscriber without a team"),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) browser.kill("SIGTERM");
    if (server) await new Promise((resolve) => server.close(resolve));
  });
