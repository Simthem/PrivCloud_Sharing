// Real Chrome check of video previews through the production FilePreview
// component, under the production document policy and the HEVC worker's own
// policy from next.config.js. Chrome decodes no HEVC without a hardware
// decoder, so the HEVC fixtures go through libde265: their pictures are
// checked on the canvas while they play, after a seek and once rotated.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const {
  createHash,
  randomBytes,
  X509Certificate,
  createCipheriv,
} = require("node:crypto");
const ts = require("typescript");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");

const root = path.resolve(__dirname, "..");
const fixtures = path.join(__dirname, "fixtures/videos");
/** Bytes served per fixture, to check what playback costs. */
const served = new Map();
const rangeRequests = new Map();
const received = new Map();
const networkMedia = new Map();
const nativeShell = process.env.PRIVCLOUD_PREVIEW_NATIVE_SHELL === "1";
const latencyMs = Math.max(
  0,
  Math.min(1000, Number(process.env.PRIVCLOUD_PREVIEW_LATENCY_MS) || 0),
);
const fixtureKey = randomBytes(32);
const encrypt = (plain) => {
  const parts = [];
  for (let at = 0; at < plain.length; at += 1_000_000) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fixtureKey, iv);
    parts.push(
      iv,
      cipher.update(plain.subarray(at, at + 1_000_000)),
      cipher.final(),
      cipher.getAuthTag(),
    );
  }
  return Buffer.concat(parts);
};

async function bundle(directory) {
  const write = (name, body) => {
    const target = path.join(directory, name);
    fs.writeFileSync(target, body);
    return target;
  };
  const util = (name) => JSON.stringify(path.join(root, "src/utils", name));
  // Same byte ranges as the site, read from the fixture route below.
  const shareStub = write(
    "share-stub.js",
    `import {createPreviewByteSource} from ${util("previewRange.util.ts")};
import {importKeyFromBase64} from ${util("crypto.util.ts")};
export const fetchFilePreviewSource=async(shareId,fileId,key,signal)=>createPreviewByteSource((start,end,readSignal)=>fetch('/api/shares/'+shareId+'/files/'+fileId+'?download=false',{headers:{Range:'bytes='+start+'-'+end},signal:readSignal}),key?await importKeyFromBase64(key):undefined,10000000,signal);
const unused=async()=>{throw new Error('not used by video previews')};
export const fetchDecryptedFile=unused,fetchFileBuffer=unused;`,
  );
  const dynamicStub = write(
    "dynamic-stub.js",
    `import React from 'react';
export default function dynamic(load){const Lazy=React.lazy(()=>load().then(m=>({default:m.default||m})));return function Dynamic(props){return React.createElement(React.Suspense,{fallback:null},React.createElement(Lazy,props));};}`,
  );
  const componentCss = write("component-styles.css", "");
  const cssLoader = path.join(
    __dirname,
    "browser-css-capture-loader.cjs",
  );
  const cssCapture = require(cssLoader);
  const loader = write(
    "loader.cjs",
    `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(source){return ts.transpileModule(source,{fileName:this.resourcePath,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;};`,
  );
  const entry = write(
    "entry.tsx",
    `import React from 'react';import {createRoot} from 'react-dom/client';import {MantineProvider} from '@mantine/core';import {IntlProvider} from 'react-intl';
import FilePreview from ${JSON.stringify(path.join(root, "src/components/share/FilePreview.tsx"))};
import messages from ${JSON.stringify(path.join(root, "src/i18n/translations/fr-FR.ts"))};
const root=createRoot(document.getElementById('root'));
const styleNonce=document.querySelector('script[nonce]').nonce;
${nativeShell ? "window.Capacitor={isNativePlatform:()=>true};" : ""}
window.showVideo=(name,size,type='video/mp4',key=null)=>root.render(<MantineProvider deduplicateCssVariables={false} getStyleNonce={()=>styleNonce}><IntlProvider locale='fr' messages={messages}><FilePreview key={name+type} shareId='fixture' fileId={name} mimeType={type} fileName={name} fileSizeBytes={size} e2eKey={key}/></IntlProvider></MantineProvider>);
window.uiReady=true;`,
  );
  const webpack = require(
    path.join(root, "node_modules/next/dist/compiled/webpack/webpack"),
  ).webpack;
  await new Promise((resolve, reject) =>
    webpack(
      {
        mode: "development",
        devtool: false,
        entry,
        output: { path: directory, filename: "bundle.js", publicPath: "/ui/" },
        plugins: [
          new webpack.DefinePlugin({
            "process.env.BUILD_TARGET": JSON.stringify(""),
            "process.env.NEXT_PUBLIC_API_ORIGIN": JSON.stringify(""),
          }),
          new webpack.NormalModuleReplacementPlugin(
            /^next\/dynamic$/,
            dynamicStub,
          ),
          new webpack.NormalModuleReplacementPlugin(
            /(?:^|\/)share\.service(?:\.ts)?$/,
            shareStub,
          ),
        ],
        resolve: {
          extensions: [".ts", ".tsx", ".js"],
          modules: [path.join(root, "node_modules"), "node_modules"],
          fallback: {
            path: require.resolve("next/dist/compiled/path-browserify"),
          },
        },
        module: {
          rules: [
            { test: /\.tsx?$/, use: loader },
            { test: /\.css$/, use: cssLoader },
          ],
        },
      },
      (error, stats) =>
        error || stats.hasErrors()
          ? reject(
              error || new Error(stats.toString({ all: false, errors: true })),
            )
          : resolve(),
    ),
  );
  fs.writeFileSync(componentCss, cssCapture.takeCss());
}

/**
 * The media fixtures are served the way the API serves share files:
 * byte ranges with Content-Range, the whole file otherwise.
 */
function serveRange(req, res, bytes) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  const headers = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(req.url.includes(".e2e")
      ? { "x-encryption-chunk-size": "1000000" }
      : {}),
  };
  if (!match) {
    res.writeHead(200, { ...headers, "content-length": bytes.length });
    res.end(bytes);
    return bytes.length;
  }
  const start = match[1] ? Number(match[1]) : bytes.length - Number(match[2]);
  const end =
    match[1] && match[2]
      ? Math.min(Number(match[2]), bytes.length - 1)
      : bytes.length - 1;
  if (start > end || start >= bytes.length) {
    res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
    res.end();
    return 0;
  }
  res.writeHead(206, {
    ...headers,
    "content-range": `bytes ${start}-${end}/${bytes.length}`,
    "content-length": end - start + 1,
  });
  res.end(bytes.subarray(start, end + 1));
  return end - start + 1;
}

async function main() {
  const { buildVideoDecoders } = await import(
    path.join(root, "scripts/build-video-decoders.mjs")
  );
  await buildVideoDecoders();
  const { buildContentSecurityPolicy } = await import(
    path.join(root, "src/utils/csp.util.ts")
  );
  const workerPolicy = (
    await require(path.join(root, "next.config.js")).headers()
  )
    .find((entry) => entry.source === "/video-decoders/hevc.worker.js")
    .headers.find((header) => header.key === "Content-Security-Policy").value;
  const nonce = randomBytes(18).toString("base64url");
  const documentPolicy = buildContentSecurityPolicy(nonce, false, [], false);
  assert.doesNotMatch(documentPolicy, /wasm-unsafe-eval/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-video-preview-"));
  // A 20 s recording with sound, moov at the end like Android writes it.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000",
    "-t",
    "20",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-b:v",
    "3M",
    "-tag:v",
    "hvc1",
    "-x265-params",
    "log-level=error",
    "-c:a",
    "aac",
    path.join(directory, "hevc-long.mp4"),
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-t",
    "20",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-b:v",
    "3M",
    path.join(directory, "h264-long.mp4"),
  ]);
  const generatedVideos = new Map([
    ["hevc-long.mp4", fs.readFileSync(path.join(directory, "hevc-long.mp4"))],
    ["h264-long.mp4", fs.readFileSync(path.join(directory, "h264-long.mp4"))],
  ]);
  for (const [name, bytes] of [...generatedVideos])
    generatedVideos.set(name + ".e2e", encrypt(bytes));
  let browser, server, send, session;
  let nextId = 0;
  const pending = new Map();
  const call = (method, params = {}, sessionId = session) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " timeout"));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          JSON.stringify(result.exceptionDetails),
      );
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 20000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value =
        typeof expression === "function"
          ? await expression()
          : await evaluate(expression);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out: " + label);
  };
  const callPageFunction = async (functionDeclaration, argumentsList = []) => {
    const globalObject = await call("Runtime.evaluate", {
      expression: "globalThis",
      returnByValue: false,
    });
    const result = await call("Runtime.callFunctionOn", {
      objectId: globalObject.result.objectId,
      functionDeclaration,
      arguments: argumentsList.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          JSON.stringify(result.exceptionDetails),
      );
    return result.result.value;
  };

  try {
    await bundle(directory);
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
        path.join(directory, "key.pem"),
        "-out",
        path.join(directory, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const cert = fs.readFileSync(path.join(directory, "cert.pem"));
    const pin = createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64");
    // Every response is loaded here, before the server starts: a request
    // only selects one of these entries and never names a file on disk.
    const resources = new Map([
      [
        "/",
        {
          type: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><title>Video preview test</title><link rel="stylesheet" href="/ui/styles.css"></head><body style="margin:0"><div id="root" style="width:min(900px, 100%)"></div><script nonce="${nonce}" src="/ui/bundle.js"></script></body></html>`,
          policy: documentPolicy,
        },
      ],
    ]);
    const structuralCss = fs
      .readFileSync(path.join(root, "node_modules/@mantine/core/styles.css"), "utf8")
      .replace(/@import\s+"([^"]+)";/g, (_, specifier) =>
        fs.readFileSync(require.resolve(specifier), "utf8"),
      );
    resources.set("/ui/styles.css", {
      type: "text/css",
      body:
        structuralCss +
        fs.readFileSync(path.join(directory, "component-styles.css"), "utf8"),
    });
    resources.set("/sw.js", {
      type: "text/javascript",
      body: "importScripts('/preview-sw.js');self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));",
    });
    resources.set("/preview-sw.js", {
      type: "text/javascript",
      body: fs.readFileSync(path.join(root, "public/preview-sw.js")),
    });
    for (const name of fs.readdirSync(directory))
      if (name.endsWith(".js"))
        resources.set(`/ui/${name}`, {
          type: "text/javascript",
          body: fs.readFileSync(path.join(directory, name)),
        });
    const decoders = path.join(root, "public/video-decoders");
    for (const name of fs.readdirSync(decoders))
      resources.set(`/video-decoders/${name}`, {
        type: name.endsWith(".wasm")
          ? "application/wasm"
          : /\.m?js$/.test(name)
            ? "text/javascript"
            : "text/plain",
        body: fs.readFileSync(path.join(decoders, name)),
        policy: name === "hevc.worker.js" ? workerPolicy : undefined,
      });
    const media = new Map(generatedVideos);
    for (const name of fs.readdirSync(fixtures))
      media.set(name, fs.readFileSync(path.join(fixtures, name)));
    const mediaPrefix = "/api/shares/fixture/files/";
    const requested = [];
    server = https.createServer(
      { key: fs.readFileSync(path.join(directory, "key.pem")), cert },
      (req, res) => {
        const { pathname } = new URL(req.url, "https://127.0.0.1");
        requested.push(pathname);
        // The path is only compared with the names served: what is sent
        // always comes from the entries loaded above.
        const fixture = [...media].find(
          ([name]) => pathname === mediaPrefix + name,
        );
        if (fixture) {
          const [name, bytes] = fixture;
          rangeRequests.set(name, (rangeRequests.get(name) || 0) + 1);
          const respond = () => {
            if (res.destroyed) return;
            served.set(
              name,
              (served.get(name) || 0) + serveRange(req, res, bytes),
            );
          };
          if (latencyMs) setTimeout(respond, latencyMs);
          else respond();
          return;
        }
        const resource = [...resources].find(([key]) => key === pathname)?.[1];
        res.writeHead(resource ? 200 : 404, {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-type": resource ? resource.type : "text/plain",
          ...(resource?.policy
            ? { "content-security-policy": resource.policy }
            : {}),
        });
        res.end(resource ? resource.body : "not found");
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `https://127.0.0.1:${server.address().port}`;
    browser = spawn(
      process.env.CHROME_PATH || "/usr/bin/google-chrome",
      [
        "--headless=new",
        "--no-first-run",
        "--no-proxy-server",
        "--disable-background-networking",
        "--autoplay-policy=no-user-gesture-required",
        "--remote-debugging-pipe",
        `--ignore-certificate-errors-spki-list=${pin}`,
        `--user-data-dir=${path.join(directory, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    send = createChromeProtocolPipe(browser, (message) => {
      if (message.method === "Network.requestWillBeSent") {
        const pathname = new URL(message.params.request.url).pathname;
        if (pathname.startsWith(mediaPrefix))
          networkMedia.set(
            message.params.requestId,
            pathname.slice(mediaPrefix.length),
          );
      }
      if (message.method === "Network.dataReceived") {
        const name = networkMedia.get(message.params.requestId);
        if (name)
          received.set(
            name,
            (received.get(name) || 0) + message.params.dataLength,
          );
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(message.error.message))
        : request.resolve(message.result);
    });
    const { targetId } = await call("Target.createTarget", {
      url: "about:blank",
    });
    session = (await call("Target.attachToTarget", { targetId, flatten: true }))
      .sessionId;
    await call("Page.enable");
    await call("Network.enable");
    await call("Page.navigate", { url: origin });
    await waitFor("window.uiReady === true", "bundle under the page CSP");

    const pageWasmBlocked = await evaluate(
      "WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(()=>false,()=>true)",
    );
    assert.equal(pageWasmBlocked, true, "document CSP must refuse WASM");
    const hevcSupported = await evaluate(
      `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')`,
    );
    assert.equal(hevcSupported, false, "this Chrome must lack HEVC");

    const show = (name, type = "video/mp4", key = null) =>
      callPageFunction(
        "function(name, size, type, key) { return this.showVideo(name, size, type, key); }",
        [
          name,
          generatedVideos.get(name)?.length ??
            fs.statSync(path.join(fixtures, name)).size,
          type,
          key,
        ],
      );
    const near = (actual, expected) =>
      actual.every(
        (channel, index) => Math.abs(channel - expected[index]) <= 36,
      );
    const RED = [220, 30, 30];
    const GREEN = [30, 200, 30];
    const BLUE = [30, 30, 220];
    const CLOCK = [
      [240, 240, 240],
      [230, 220, 40],
      [210, 40, 210],
    ];
    const pictureAt = (second, rotated = false) => {
      const expected = rotated
        ? [BLUE, RED, CLOCK[second], GREEN]
        : [RED, GREEN, BLUE, CLOCK[second]];
      return () =>
        callPageFunction(
          `function(expected) {
            const c = document.querySelector('canvas');
            if (!c || c.width === 300) return null;
            const context = c.getContext('2d');
            const at = (u, v) => [...context.getImageData(
              Math.floor(u * c.width), Math.floor(v * c.height), 1, 1
            ).data].slice(0, 3);
            const picture = {
              size: [c.width, c.height],
              corners: [at(.25, .25), at(.75, .25), at(.25, .75), at(.75, .75)],
            };
            return picture.corners.every((channels, index) =>
              channels.every((value, channel) =>
                Math.abs(value - expected[index][channel]) <= 36
              )
            ) ? picture : null;
          }`,
          [expected],
        );
    };
    const label = (text) => `document.querySelector('[aria-label="${text}"]')`;

    // 1. HEVC with sound: the native element loads the sound but no
    // picture. The software player takes over, the sound keeps the time.
    await show("hevc-quadrants.mp4");
    const poster = await waitFor(pictureAt(0), "HEVC poster picture");
    assert.deepEqual(poster.size, [64, 48]);
    assert.equal(
      await evaluate("document.querySelectorAll('audio').length"),
      1,
      "the sound plays through the browser",
    );
    // Use the shipped structural CSS plus the component's lazy CSS. A missing
    // Slider import must produce a zero-height thumb and fail this check.
    const controls =
      await evaluate(`(()=>[...document.querySelectorAll('[role="slider"]')].map(thumb=>{
      const root=thumb.closest('.mantine-Slider-root');const box=root.getBoundingClientRect();const handle=thumb.getBoundingClientRect();
      return {label:thumb.getAttribute('aria-label'),x:box.x,y:handle.y,width:box.width,height:handle.height,color:getComputedStyle(thumb).backgroundColor};
    }))()`);
    assert.equal(controls.length, 2, "timeline and volume controls");
    assert.ok(
      controls.every(
        (control) =>
          control.width >= 60 &&
          control.height >= 8 &&
          control.color !== "rgba(0, 0, 0, 0)",
      ),
      JSON.stringify(controls),
    );
    const sound = controls.find((control) => control.label === "Volume");
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: sound.x + sound.width * 0.25,
      y: sound.y + sound.height / 2,
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: sound.x + sound.width * 0.25,
      y: sound.y + sound.height / 2,
      button: "left",
      clickCount: 1,
    });
    await waitFor(
      "document.querySelector('audio').volume>=0.15 && document.querySelector('audio').volume<=0.35",
      "volume slider changes actual audio",
    );
    const volume = await evaluate("document.querySelector('audio').volume");
    assert.ok(
      volume >= 0.15 && volume <= 0.35,
      `volume slider changed the audio volume: ${volume}`,
    );
    await evaluate(
      "document.querySelector('[role=slider][aria-label=Volume]').focus()",
    );
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowRight",
      code: "ArrowRight",
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowRight",
      code: "ArrowRight",
    });
    assert.equal(
      await evaluate("document.querySelector('audio').currentTime"),
      0,
      "volume keyboard does not seek video",
    );
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(
        os.tmpdir(),
        root.includes("vNative1")
          ? "privcloud-native-video-controls.png"
          : "privcloud-v2-video-controls.png",
      ),
      Buffer.from(shot.data, "base64"),
    );
    await call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const narrow = await evaluate(
      "(()=>{const box=document.querySelector('[tabindex=\"0\"]').getBoundingClientRect();return [...document.querySelectorAll('[role=slider],button[aria-label]')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=box.left&&r.right<=box.right+1;});})()",
    );
    assert.equal(narrow, true, "all video controls fit at 390 px");
    await call("Emulation.clearDeviceMetricsOverride");
    // Fullscreen must keep the existing canvas/audio and work when the API is
    // absent or rejects, as on mobile WebViews. Escape restores focus and scroll.
    const checkFullscreen = async (nativePlayer = false) => {
      const media = nativePlayer ? "video" : "canvas";
      await evaluate(
        `window.keptMedia=document.querySelector('${media}');window.keptAudio=document.querySelector('audio');window.oldOverflow=document.body.style.overflow`,
      );
      await evaluate(`${label("Plein écran")}.click()`);
      await waitFor(
        `!!document.fullscreenElement && !!${label("Quitter le plein écran")}`,
        "browser fullscreen",
      );
      assert.equal(
        await evaluate(`window.keptMedia===document.querySelector('${media}')`),
        true,
      );
      await evaluate(`${label("Quitter le plein écran")}.click()`);
      await waitFor(
        `!document.fullscreenElement && !!${label("Plein écran")}`,
        "exit browser fullscreen",
      );
      await evaluate(`${label("Plein écran")}.click()`);
      await waitFor(
        `!!document.fullscreenElement && !!${label("Quitter le plein écran")}`,
        "reenter fullscreen",
      );
      await evaluate(
        "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
      );
      await waitFor(
        `!document.fullscreenElement && !!${label("Plein écran")}`,
        "Android Back/Escape exits fullscreen first",
      );
      for (const rejected of [false, true]) {
        if (rejected)
          await call("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: false,
          });
        await evaluate(
          `window.oldFullscreen=HTMLElement.prototype.requestFullscreen;HTMLElement.prototype.requestFullscreen=${rejected ? "()=>Promise.reject(new Error('denied'))" : "undefined"}`,
        );
        await evaluate(`${label("Plein écran")}.click()`);
        await waitFor(
          "!!document.querySelector('body > [aria-modal=true]')",
          "WebView fullscreen fallback",
        );
        assert.equal(
          await evaluate(
            `(()=>{const host=document.querySelector('body > [aria-modal=true]'),r=host.getBoundingClientRect();return r.width>=innerWidth-1&&r.height>=innerHeight-1&&window.keptMedia===document.querySelector('${media}')&&window.keptAudio===document.querySelector('audio')})()`,
          ),
          true,
        );
        await call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
        });
        await call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
        });
        await waitFor(
          "!document.querySelector('body > [aria-modal=true]')",
          "exit fallback fullscreen",
        );
        assert.equal(
          await evaluate("document.body.style.overflow===window.oldOverflow"),
          true,
        );
        await waitFor(
          `!!${label("Plein écran")}`,
          "restored fullscreen button",
        );
        await evaluate(
          "HTMLElement.prototype.requestFullscreen=window.oldFullscreen",
        );
        if (rejected) await call("Emulation.clearDeviceMetricsOverride");
      }
    };
    await checkFullscreen();
    let started = Date.now();
    await evaluate(`${label("Lire")}.click()`);
    await waitFor(pictureAt(1), "picture of second 1 while playing");
    await waitFor(pictureAt(2), "picture of second 2 while playing");
    assert.ok(Date.now() - started >= 1500, "plays at the pace of the sound");
    assert.equal(
      await evaluate(
        "(()=>{const a=document.querySelector('audio');return a.src.startsWith('blob:')&&a.currentTime>1})()",
      ),
      true,
      "the sound alone, through Media Source",
    );
    await waitFor(`!!${label("Lire")}`, "end of playback", 10000);
    // Back to the start with the keyboard, from the end.
    await evaluate(
      `(()=>{const box=document.querySelector('[tabindex="0"]');box.focus();box.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));})()`,
    );
    await waitFor(pictureAt(0), "seek back to the first second");

    // 2. HEVC without sound: the native element fails outright. The pictures
    // keep their own time.
    await show("hevc-quadrants-silent.mp4");
    await waitFor(pictureAt(0), "silent HEVC poster");
    assert.equal(
      await evaluate("document.querySelectorAll('audio').length"),
      0,
    );
    started = Date.now();
    await evaluate(`${label("Lire")}.click()`);
    await waitFor(pictureAt(1), "silent HEVC picture of second 1");
    await waitFor(pictureAt(2), "silent HEVC picture of second 2");
    assert.ok(
      Date.now() - started >= 1500,
      "plays at the pace of its own clock",
    );

    // 3. A portrait recording: the track matrix turns it a quarter clockwise.
    await show("hevc-quadrants-rotate90.mp4");
    const rotated = await waitFor(pictureAt(0, true), "rotated picture");
    assert.deepEqual(rotated.size, [48, 64]);

    // 4. 10-bit HEVC.
    await show("hevc-quadrants-main10.mp4");
    await waitFor(pictureAt(0), "10-bit HEVC picture");

    // 5. H.264 stays with the native player.
    await show("h264-quadrants.mp4");
    await waitFor(
      "(()=>{const v=document.querySelector('video');return v&&v.videoWidth===64})()",
      "native H.264 playback",
    );
    assert.equal(
      await evaluate("document.querySelectorAll('canvas').length"),
      0,
    );

    // 6. A codec neither Chrome nor the fallback decodes is named.
    await show("mpeg4-quadrants.mp4");
    const message = await waitFor(
      "(()=>{const t=document.body.innerText;return t.includes('MPEG-4 Part 2')&&t})()",
      "unsupported codec message",
    );
    assert.match(message, /Format vidéo non pris en charge/);

    // 7. An MP4 with sound only is played as sound, not as a black frame.
    await show("aac-only.mp4");
    await waitFor(
      "(()=>{const a=document.querySelector('audio[controls]');return a&&!document.querySelector('video')&&a.readyState>=1})()",
      "sound-only MP4",
    );

    // 8. A long recording: playback reads what it plays, pictures and sound
    // sharing each downloaded block, instead of the whole file.
    const long = generatedVideos.get("hevc-long.mp4");
    const longStarted = Date.now();
    await show("hevc-long.mp4");
    await waitFor(
      "document.querySelector('canvas')?.width===640",
      "long recording poster",
    );
    const opening = served.get("hevc-long.mp4") || 0;
    console.log(
      JSON.stringify({
        scenario: "hevc-opening",
        latencyMs,
        openingMs: Date.now() - longStarted,
        receivedBytes: received.get("hevc-long.mp4") || 0,
        requests: rangeRequests.get("hevc-long.mp4"),
      }),
    );
    await evaluate(`${label("Lire")}.click()`);
    await waitFor(
      "document.querySelector('audio')?.currentTime>=4",
      "four seconds of playback",
    );
    const read = served.get("hevc-long.mp4") || 0;
    console.log(
      `long recording: ${opening} bytes to open, ${read} after 4 s of 20 s, of ${long.length}`,
    );
    // Starting the browser player on HEVC, or giving it the whole file for
    // the sound, read more than the file itself before the first second.
    assert.ok(opening < long.length * 0.5, `opening read ${opening}`);
    assert.ok(read < long.length * 0.7, `playback read ${read}`);

    // 9. A QuickTime recording: its sound entry is rewritten for Media Source.
    await show("hevc-quadrants.mov", "video/quicktime");
    await waitFor(pictureAt(0), "QuickTime poster");
    await evaluate(`${label("Lire")}.click()`);
    await waitFor(pictureAt(1), "QuickTime picture of second 1");
    assert.equal(
      await evaluate(
        "(()=>{const a=document.querySelector('audio');return a.src.startsWith('blob:')&&a.currentTime>0.5&&!a.error})()",
      ),
      true,
      "QuickTime sound through Media Source",
    );

    // 10. A browser claiming HEVC it cannot decode, like some Android
    // WebViews: its player fails, and the pictures are decoded here.
    await evaluate(
      "window.isTypeSupported=MediaSource.isTypeSupported;MediaSource.isTypeSupported=()=>true",
    );
    await show("hevc-quadrants-silent.mp4");
    await waitFor(pictureAt(0), "fallback after the browser player failed");
    await evaluate("MediaSource.isTypeSupported=window.isTypeSupported");

    // 11. Real native playback and seeking, both clear and independently
    // authenticated E2E records, with configurable network round-trip latency.
    for (const encrypted of [false, true]) {
      const name = "h264-long.mp4" + (encrypted ? ".e2e" : "");
      const before = Date.now();
      await show(
        name,
        "video/mp4",
        encrypted ? fixtureKey.toString("base64url") : null,
      );
      await waitFor(
        "(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&v.videoWidth===640})()",
        "H.264 first picture",
        15000,
      );
      if (!encrypted) await checkFullscreen(true);
      const openingMs = Date.now() - before;
      const openingBytes = received.get(name) || 0;
      await evaluate("document.querySelector('video').play()");
      await waitFor(
        "document.querySelector('video')?.currentTime>=2",
        "H.264 playback",
      );
      const seekStart = Date.now();
      await evaluate("document.querySelector('video').currentTime=12");
      await waitFor(
        "(()=>{const v=document.querySelector('video');return v&&!v.seeking&&v.readyState>=2&&v.currentTime>=12})()",
        "H.264 seek",
        10000,
      );
      const seekMs = Date.now() - seekStart;
      const quality = await evaluate(
        "(()=>{const q=document.querySelector('video').getVideoPlaybackQuality();return {total:q.totalVideoFrames,dropped:q.droppedVideoFrames}})()",
      );
      console.log(
        JSON.stringify({
          scenario: "h264",
          encrypted,
          latencyMs,
          openingMs,
          seekMs,
          openingBytes,
          fileBytes: generatedVideos.get(name).length,
          requests: rangeRequests.get(name),
          ...quality,
        }),
      );
      assert.ok(openingMs < 15000 && seekMs < 10000);
      assert.ok(
        openingBytes < generatedVideos.get(name).length * 0.7,
        "opening stays progressive",
      );
      assert.ok(
        quality.dropped <= Math.max(5, quality.total * 0.2),
        "native playback frame loss stays bounded",
      );
    }

    // 12. An encrypted HEVC recording. Two immediate jumps abandon the
    // first pending read, while the final target still gets decoded.
    const encryptedStart = Date.now();
    await show(
      "hevc-long.mp4.e2e",
      "video/mp4",
      fixtureKey.toString("base64url"),
    );
    await waitFor(
      "document.querySelector('canvas')?.width===640",
      "encrypted HEVC poster",
    );
    const encryptedOpeningMs = Date.now() - encryptedStart;
    await evaluate(`${label("Lire")}.click()`);
    await waitFor(
      "document.querySelector('audio')?.currentTime>=2",
      "encrypted HEVC playback",
    );
    await evaluate(`${label("Pause")}.click()`);
    const picture = await evaluate(
      "document.querySelector('canvas').toDataURL()",
    );
    const jumpStart = Date.now();
    await evaluate(
      `(()=>{const box=document.querySelector('[tabindex="0"]');box.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));box.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`,
    );
    await waitFor(
      `document.querySelector('audio')?.currentTime>=12&&document.querySelector('canvas')?.toDataURL()!==${JSON.stringify(picture)}`,
      "encrypted HEVC picture after consecutive seeks",
    );
    console.log(
      JSON.stringify({
        scenario: "hevc-e2e",
        latencyMs,
        openingMs: encryptedOpeningMs,
        seekMs: Date.now() - jumpStart,
        requests: rangeRequests.get("hevc-long.mp4.e2e"),
        receivedBytes: received.get("hevc-long.mp4.e2e"),
      }),
    );

    assert.ok(requested.includes("/video-decoders/libde265.wasm"));
    console.log(
      "real Chrome without HEVC: HEVC in MP4 and QuickTime, with and without sound, rotated and 10-bit, decoded on the device under the production CSP, the sound alone through Media Source, reading what is played; H.264 native, other codecs named, sound-only files played as sound",
    );
  } finally {
    browser?.kill("SIGKILL");
    server?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
