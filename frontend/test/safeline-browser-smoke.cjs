const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const ts = require("typescript");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "privcloud-waf-browser-"));
let browser, server;
const pending = new Map();
let nextId = 0, send, stderr = "";
let incompleteProbes = 0;
async function command(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Browser command timeout: " + method)); }, 10000);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  });
}
async function waitUntil(check, description) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + description + "\n" + stderr);
}
(async () => {
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(fixture, "key.pem"), "-out", path.join(fixture, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const certificate = fs.readFileSync(path.join(fixture, "cert.pem"));
    const pubkey = execFileSync("openssl", ["x509", "-pubkey", "-noout"], { input: certificate });
    const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: pubkey });
    const fingerprint = require("node:crypto").createHash("sha256").update(der).digest("base64");
    const clock = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/utils/uploadClock.util.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const helper = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/utils/safelineChallenge.util.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const maintenance = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/utils/uploadSessionMaintenance.util.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('"./safelineChallenge.util"', '"/helper.js"');
    let challengeLoaded = false, verificationCount = 0, iframeChallenges = 0, parentLoads = 0, unexpectedNavigations = 0;
    server = https.createServer({ key: fs.readFileSync(path.join(fixture, "key.pem")), cert: certificate }, (req, res) => {
      const url = new URL(req.url, "https://localhost");
      res.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/helper.js") {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(helper.replaceAll("./uploadClock.util", "/clock-helper.js"));
      } else if (url.pathname === "/maintenance.js") {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(maintenance.replaceAll("./uploadClock.util", "/clock-helper.js"));
      } else if (url.pathname === "/clock-helper.js") {
        res.setHeader("Content-Type", "text/javascript"); res.end(clock);
      } else if (url.pathname === "/upload-clock-worker.js") {
        res.setHeader("Content-Type", "text/javascript"); res.end(fs.readFileSync(path.join(__dirname, "../public/upload-clock-worker.js")));
      } else if (url.pathname === "/unexpected-reload") {
        unexpectedNavigations++;
        res.setHeader("Content-Type", "text/plain"); res.end("Unexpected navigation");
      } else if (url.pathname === "/background-parent") {
        parentLoads++;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><title>Background upload</title><script type="module">import {completeSafeLineChallenge} from "/helper.js"; import {startUploadSessionMaintenance} from "/maintenance.js"; window.selectedFile=new File(["fixture data"],"fixture.bin");window.originalFile=window.selectedFile;window.heartbeats=0;window.pending=true;window.key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);window.originalKey=window.key;window.stopMaintenance=startUploadSessionMaintenance({isActive:()=>window.pending,heartbeat:async()=>{window.heartbeats++},resolveChallenge:completeSafeLineChallenge});window.fixtureReady=true;</script>');
      } else if (url.pathname === "/" && url.searchParams.has("_sl_validate")) {
        const verified = /(?:^|;\s*)fixture_session=ready(?:;|$)/.test(req.headers.cookie || "");
        res.statusCode = verified ? 200 : 468;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.on("close", () => { if (!res.writableFinished) incompleteProbes++; });
        res.write("<!doctype html><title>Session probe</title>" + " ".repeat(64_000));
        setTimeout(() => res.end("<!-- complete -->"), 50);
      } else if (url.pathname === "/" && (url.searchParams.has("_sl_iframe") || url.searchParams.has("verified_iframe"))) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (!/(?:^|;\s*)fixture_session=ready(?:;|$)/.test(req.headers.cookie || "")) {
          iframeChallenges++;
          res.statusCode = 468;
          res.end('<!doctype html><title>Automatic verification</title><script>setTimeout(()=>{document.cookie="fixture_session=ready; Path=/; Secure; SameSite=Strict";try{window.top.location.href="/unexpected-reload"}catch{}location.replace("/?verified_iframe=1")},1000)</script>');
        } else res.end("<!doctype html><title>Verified frame</title>");
      } else if (url.pathname === "/api/configs") {
        verificationCount++;
        const verified = /(?:^|;\s*)fixture_session=ready(?:;|$)/.test(req.headers.cookie || "");
        res.statusCode = verified ? 200 : 468;
        res.setHeader("Content-Type", verified ? "application/json" : "text/html");
        res.end(verified ? "[]" : "<p>Verification pending</p>");
      } else if (url.pathname === "/parent") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        // The popup uses a different COOP policy, severing its WindowProxy.
        res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
        res.end('<!doctype html><title>Upload fixture</title><script type="module">import {resolveChallengeViaPopup,prepareSafeLineRetry} from "/helper.js";window.primeBlockedPopup=async()=>{const original=window.open;window.open=()=>null;try{await resolveChallengeViaPopup()}catch{}finally{window.open=original}};window.start=()=>{window.result="pending";prepareSafeLineRetry().then(()=>window.result="complete",()=>window.result="failed")};window.fixtureReady=true;</script>');
      } else if (url.pathname === "/" && url.searchParams.get("_sl_popup") === "1") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        if (!/(?:^|;\s*)fixture_session=ready(?:;|$)/.test(req.headers.cookie || "")) {
          challengeLoaded = true;
          res.end('<!doctype html><title>Verification fixture</title><script>setTimeout(()=>{document.cookie="fixture_session=ready; Path=/; Secure; SameSite=Strict";location.reload()},2000)</script>');
        } else {
          res.end('<!doctype html><title>Verified fixture</title><script type="module">import {handleSafeLineChallengeWindow} from "/helper.js";handleSafeLineChallengeWindow();</script>');
        }
      } else {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("Not found");
      }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    browser = spawn(process.env.CHROME_BIN || "/opt/google/chrome/google-chrome", ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe", `--ignore-certificate-errors-spki-list=${fingerprint}`, `--user-data-dir=${path.join(fixture, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    browser.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    browser.on("error", error => { for (const item of pending.values()) item.reject(error); });
    send = createChromeProtocolPipe(browser, message => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timeout);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    });
    const background = await command("Target.createTarget", { url: `https://127.0.0.1:${port}/background-parent` });
    const attached = await command("Target.attachToTarget", { targetId: background.targetId, flatten: true });
    async function backgroundEvaluate(expression) {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: false }, attached.sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    await waitUntil(() => backgroundEvaluate("window.fixtureReady === true"), "background upload ready");
    await waitUntil(() => backgroundEvaluate("window.heartbeats === 1"), "automatic iframe verification without user action");
    assert.equal(parentLoads, 1); assert.equal(unexpectedNavigations, 0);
    assert.equal(await backgroundEvaluate("window.selectedFile === window.originalFile && window.key === window.originalKey && location.pathname === '/background-parent'"), true);
    assert.equal(await backgroundEvaluate("document.querySelectorAll('iframe').length"), 0);
    await backgroundEvaluate("document.cookie='fixture_session=; Path=/; Secure; Max-Age=0'; window.dispatchEvent(new Event('focus'))");
    await waitUntil(() => backgroundEvaluate("document.querySelectorAll('iframe').length === 1"), "wake-up checks the document session immediately");
    await waitUntil(async () => iframeChallenges === 2 && await backgroundEvaluate("document.querySelectorAll('iframe').length === 0"), "wake-up verification completes silently");
    assert.equal(parentLoads, 1); assert.equal(unexpectedNavigations, 0);
    assert.equal(await backgroundEvaluate("window.selectedFile === window.originalFile && window.key === window.originalKey"), true);
    assert.equal((await command("Target.getTargets")).targetInfos.some(t => t.url.includes("_sl_popup=1")), false);
    await backgroundEvaluate("window.stopMaintenance();document.cookie='fixture_session=; Path=/; Secure; Max-Age=0'");
    await command("Target.closeTarget", { targetId: background.targetId });
    console.log("ok - automatic iframe and wake-up verification retain upload state without main-tab navigation or popup");
    const { targetId } = await command("Target.createTarget", { url: `https://127.0.0.1:${port}/parent` });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    async function evaluate(expression) {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    await waitUntil(() => evaluate("window.fixtureReady === true"), "parent ready");
    await evaluate("window.primeBlockedPopup()");
    await evaluate("window.start()");
    await waitUntil(async () => challengeLoaded && (await command("Target.getTargets")).targetInfos.some(t => t.url.includes("_sl_popup=1")), "challenge popup opened");
    assert.equal(await evaluate("window.result"), "pending");
    await waitUntil(() => evaluate('window.result === "complete"'), "verified session resumes upload");
    await waitUntil(async () => !(await command("Target.getTargets")).targetInfos.some(t => t.url.includes("_sl_popup=1")), "isolated popup closes itself");
    assert.ok(verificationCount >= 2, "The API session was probed before and after verification");
    assert.equal(incompleteProbes, 0, "Session validation cancelled an upstream response");
    console.log("ok - isolated WAF popup closes and resumes after verified HTTPS API response");
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error("Browser fixture stopped")); }
    pending.clear();
    if (browser && browser.exitCode === null) { browser.kill("SIGTERM"); await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); }); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
