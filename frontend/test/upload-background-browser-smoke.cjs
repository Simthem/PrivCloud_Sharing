const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const { createHash, createDecipheriv } = require("node:crypto");
const ts = require("typescript");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");

const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "privcloud-upload-browser-"),
);
const pending = new Map();
const fileId = "b53173ae-a482-4d17-b952-246df7317c8a";
const partBytes = 1024 * 1024,
  recordBytes = 256 * 1024,
  partCount = 64;
const key = Buffer.alloc(32, 7);
let browser,
  api,
  storage,
  send,
  nextId = 0,
  stderr = "";
async function command(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Browser command timeout: " + method));
    }, 10000);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  });
}
async function waitUntil(check, description) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + description + "\n" + stderr);
}
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
const body = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const transpile = (name) =>
  ts
    .transpileModule(
      fs.readFileSync(
        path.join(__dirname, "../src/utils/" + name + ".ts"),
        "utf8",
      ),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      },
    )
    .outputText.replaceAll("./uploadClock.util", "/clock.js");

(async () => {
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
        path.join(fixture, "key.pem"),
        "-out",
        path.join(fixture, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    const cert = fs.readFileSync(path.join(fixture, "cert.pem"));
    const tls = { key: fs.readFileSync(path.join(fixture, "key.pem")), cert };
    const pubkey = execFileSync("openssl", ["x509", "-pubkey", "-noout"], {
      input: cert,
    });
    const fingerprint = createHash("sha256")
      .update(
        execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], {
          input: pubkey,
        }),
      )
      .digest("base64");
    const uploaded = new Set(),
      errors = [],
      gaps = [];
    let active = 0,
      maximumActive = 0,
      lastCompletion = 0,
      authorizationRequests = 0;
    storage = https.createServer(tls, async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.end();
        return;
      }
      if (active === 0 && lastCompletion)
        gaps.push(Date.now() - lastCompletion);
      maximumActive = Math.max(maximumActive, ++active);
      try {
        const index = Number(req.url.split("/").pop());
        const encrypted = await body(req);
        assert.equal(encrypted.length, partBytes + 4 * 28);
        for (
          let offset = 0;
          offset < encrypted.length;
          offset += recordBytes + 28
        ) {
          const record = encrypted.subarray(offset, offset + recordBytes + 28);
          const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            record.subarray(0, 12),
          );
          decipher.setAuthTag(record.subarray(-16));
          const plain = Buffer.concat([
            decipher.update(record.subarray(12, -16)),
            decipher.final(),
          ]);
          assert.equal(plain.equals(Buffer.alloc(recordBytes, 0x5a)), true);
        }
        assert.equal(
          uploaded.has(index),
          false,
          "healthy parts were sent twice",
        );
        uploaded.add(index);
        await new Promise((resolve) => setTimeout(resolve, 650));
        res.end("{}");
      } catch (error) {
        errors.push(error);
        res.statusCode = 500;
        res.end("{}");
      } finally {
        active--;
        lastCompletion = Date.now();
      }
    });
    await listen(storage);
    const storageOrigin = "https://127.0.0.1:" + storage.address().port;
    const pool = {
      id: fileId,
      uploadTransport: "direct-s3",
      uploadWindowMode: "browser-origin-pool",
      uploadConcurrency: 6,
      uploadGlobalConcurrency: 6,
      uploadOriginCount: 1,
      uploadConnectionsPerOrigin: 6,
      uploadMaxConcurrency: 6,
      uploadedParts: [],
    };
    const clock = transpile("uploadClock.util"),
      coordinator = transpile("uploadBatchCoordinator.util");
    api = https.createServer(tls, async (req, res) => {
      const url = new URL(req.url, "https://localhost");
      res.setHeader("Cache-Control", "no-store");
      if (
        ["/upload-worker.js", "/upload-clock-worker.js"].includes(url.pathname)
      ) {
        res.setHeader("Content-Type", "text/javascript");
        res.end(
          fs.readFileSync(
            path.join(__dirname, "../public", url.pathname.slice(1)),
          ),
        );
      } else if (["/clock.js", "/coordinator.js"].includes(url.pathname)) {
        res.setHeader("Content-Type", "text/javascript");
        res.end(url.pathname === "/clock.js" ? clock : coordinator);
      } else if (url.pathname === "/upload") {
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><title>Hidden upload fixture</title><script type="module">
          import {scheduleUploadTimeout} from '/clock.js';
          import {UploadBatchCoordinator} from '/coordinator.js';
          window.ready=true;
          window.clockCheck=async()=>{
            const original=window.setTimeout;
            try {
              window.setTimeout=(fn,delay,...args)=>original(fn,Math.max(60000,delay),...args);
              return await new Promise(resolve=>{const start=performance.now();scheduleUploadTimeout(()=>resolve(performance.now()-start),250)});
            } finally {window.setTimeout=original}
          };
          window.clockForgeryCheck=async()=>{
            const OriginalWorker=window.Worker, originalTimer=window.setTimeout;
            let tapped, release, cancel=()=>{}, fired=false;
            const observed=new Promise(resolve=>release=resolve);
            const block=event=>{event.stopImmediatePropagation();release(event.data)};
            try {
              window.Worker=class extends OriginalWorker {
                constructor(url,...args){super(url,...args);if(url==='/upload-clock-worker.js'){tapped=this;this.addEventListener('message',block,{capture:true})}}
              };
              window.setTimeout=(fn,delay,...args)=>originalTimer(fn,Math.max(60000,delay),...args);
              cancel=scheduleUploadTimeout(()=>{fired=true},250);
              const reply=await observed;
              tapped.dispatchEvent(new MessageEvent('message',{data:reply,origin:'https://attacker.example'}));
              tapped.dispatchEvent(new MessageEvent('message',{data:reply,origin:''}));
              const rejected=!fired;
              if(!rejected)return {rejected,legitimate:false};
              tapped.removeEventListener('message',block,{capture:true});
              const completed=new Promise(resolve=>tapped.addEventListener('message',()=>resolve(fired),{once:true}));
              tapped.postMessage({type:'schedule',id:reply.id,deadline:Date.now()});
              return {rejected,legitimate:await completed};
            } finally {cancel();window.Worker=OriginalWorker;window.setTimeout=originalTimer}
          };
          window.start=()=>{
            const worker=new Worker('/upload-worker.js');
            const coordinator=new UploadBatchCoordinator();
            const flow=coordinator.registerFlow(maxParallel=>worker.postMessage({type:'direct-window-update',maxParallel}));
            window.uploadResult='pending';window.worker=worker;
            worker.onmessage=async({data:m})=>{
              if(m.type==='direct-pool-config')coordinator.configure(m);
              if(m.type==='acquire-direct-slot'){const grant=await coordinator.acquireDirect(flow,m.candidates);worker.postMessage({type:'direct-slot-granted',requestId:m.requestId,...grant})}
              if(m.type==='release-direct-slot')coordinator.releaseDirect(m.leaseId,m.outcome,m.retryAfterMs);
              if(['batch-complete','error','quota-exceeded'].includes(m.type)){window.uploadResult=m;coordinator.close();worker.terminate()}
            };
            worker.postMessage({type:'start',shareId:'fixture',fileId:'${fileId}',fileName:'fixture.bin',file:new File([new Uint8Array(${partBytes * partCount}).fill(0x5a)],'fixture.bin'),chunkSize:${partBytes},initialChunkSize:${partBytes},cryptoChunkSize:${recordBytes},totalChunks:${partCount},isE2E:true,cryptoKeyRaw:new Uint8Array(32).fill(7),serverManagedWindow:true,maxParallelLanes:6});
          };
        </script>`);
      } else if (url.pathname === "/cover") {
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><title>Visible tab</title>");
      } else if (url.pathname.endsWith("/multipart/init")) {
        await body(req);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(pool));
      } else if (url.pathname.endsWith("/multipart/part-urls")) {
        const payload = JSON.parse(await body(req));
        authorizationRequests++;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ...pool,
            parts: payload.parts.map((part) => ({
              ...part,
              partNumber: part.chunkIndex + 1,
              url: storageOrigin + "/part/" + part.chunkIndex,
            })),
          }),
        );
      } else if (url.pathname.endsWith("/multipart/complete")) {
        await body(req);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: fileId,
            uploadComplete: uploaded.size === partCount && errors.length === 0,
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await listen(api);
    const origin = "https://127.0.0.1:" + api.address().port;
    browser = spawn(
      process.env.CHROME_BIN || "/opt/google/chrome/google-chrome",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-pipe",
        `--ignore-certificate-errors-spki-list=${fingerprint}`,
        `--user-data-dir=${path.join(fixture, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
    browser.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-4000);
    });
    send = createChromeProtocolPipe(browser, (message) => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timeout);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
    const { targetId } = await command("Target.createTarget", {
      url: origin + "/upload",
      background: true,
    });
    const { sessionId } = await command("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const cover = await command("Target.createTarget", {
      url: origin + "/cover",
    });
    await command("Target.activateTarget", { targetId: cover.targetId });
    const evaluate = async (expression) => {
      const result = await command(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await waitUntil(() => evaluate("window.ready===true"), "hidden tab ready");
    assert.equal(await evaluate("document.visibilityState"), "hidden");
    const elapsed = await evaluate("window.clockCheck()");
    assert.ok(
      elapsed >= 200 && elapsed < 900,
      "hidden upload deadline took " + elapsed + "ms",
    );
    assert.deepEqual(await evaluate("window.clockForgeryCheck()"), {
      rejected: true,
      legitimate: true,
    });
    await evaluate("window.start()");
    await waitUntil(
      () => evaluate("window.uploadResult!=='pending'"),
      "encrypted upload completes in hidden tab",
    );
    assert.equal(await evaluate("document.visibilityState"), "hidden");
    assert.equal(
      (await evaluate("window.uploadResult")).type,
      "batch-complete",
    );
    assert.deepEqual(errors, []);
    assert.equal(uploaded.size, partCount);
    assert.equal(authorizationRequests, Math.ceil(partCount / 12));
    assert.equal(maximumActive, 6);
    assert.ok(
      Math.max(0, ...gaps) < 500,
      "authorization exhausted all sockets for " + Math.max(...gaps) + "ms",
    );
    console.log(
      `ok - hidden deadline ${Math.round(elapsed)}ms, 64 MiB AES-GCM verified, 6 shared sockets, maximum idle gap ${Math.max(0, ...gaps)}ms with 1200ms API latency`,
    );
  } finally {
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error("Browser fixture stopped"));
    }
    pending.clear();
    if (browser && browser.exitCode === null) {
      browser.kill("SIGTERM");
      await new Promise((resolve) => {
        browser.once("exit", resolve);
        setTimeout(resolve, 3000);
      });
    }
    for (const server of [api, storage])
      if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
