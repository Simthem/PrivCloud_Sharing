// Real Chrome check of HEIC/TIFF/RAW previews: the production client utility,
// worker and decoders, under the production document policy and the worker's
// own policy from next.config.js. IMAGE_DECODER_SAMPLES=<dir> also decodes
// every .heic/.tif/RAW file found there and reports its size.
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
const { rawPreviewFixture } = require("./fixtures/raw-previews.cjs");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");

const root = path.resolve(__dirname, "..");
const transpile = (relative) =>
  ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

const SAMPLE_EXTENSIONS =
  /\.(heic|heif|tiff?|dng|cr2|cr3|nef|nrw|arw|orf|rw2|pef|raf|srw)$/i;

async function main() {
  const { buildImageDecoders } = await import(
    path.join(root, "scripts/build-image-decoders.mjs")
  );
  await buildImageDecoders();
  const { buildContentSecurityPolicy } = await import(
    path.join(root, "src/utils/csp.util.ts")
  );
  const workerHeaders = (
    await require(path.join(root, "next.config.js")).headers()
  ).find(
    (entry) => entry.source === "/image-decoders/decoder.worker.js",
  ).headers;
  const workerPolicy = workerHeaders.find(
    (header) => header.key === "Content-Security-Policy",
  ).value;
  const nonce = randomBytes(18).toString("base64url");
  const documentPolicy = buildContentSecurityPolicy(nonce, false, [], false);
  assert.doesNotMatch(documentPolicy, /wasm-unsafe-eval/);

  const decoderDirectory = path.join(root, "public/image-decoders");
  const resources = {
    "/": [
      "text/html",
      `<!doctype html><title>Image decoder test</title><script type="module" nonce="${nonce}" src="/client.mjs"></script>`,
    ],
    "/client.mjs": [
      "text/javascript",
      transpile("src/utils/imageDecoder.util.ts").replace(
        '"./imageFormats.util"',
        '"/imageFormats.mjs"',
      ) +
        "\nglobalThis.toDisplayableImageBlob = toDisplayableImageBlob;\n" +
        "globalThis.toDisplayableDecodedImageBlob = toDisplayableDecodedImageBlob;\n" +
        'import {readRawRangePreview} from "/rawPreview.mjs";import {createPreviewByteSource} from "/ranges.mjs";import {importKeyFromBase64} from "/crypto.mjs";globalThis.readRawRangePreview=readRawRangePreview;globalThis.createPreviewByteSource=createPreviewByteSource;globalThis.importKeyFromBase64=importKeyFromBase64;\n' +
        "globalThis.clientReady = true;\n",
    ],
    "/imageFormats.mjs": [
      "text/javascript",
      transpile("src/utils/imageFormats.util.ts"),
    ],
  };
  const moduleNames = {
    "/rawPreview.mjs": "rawPreview.util",
    "/ranges.mjs": "previewRange.util",
    "/imageCore.mjs": "imageDecoderCore.util",
    "/crypto.mjs": "crypto.util",
    "/readCache.mjs": "previewReadCache.util",
  };
  for (const [route, name] of Object.entries(moduleNames))
    resources[route] = [
      "text/javascript",
      transpile("src/utils/" + name + ".ts")
        .replaceAll('"./imageDecoderCore.util"', '"/imageCore.mjs"')
        .replaceAll('"./previewRange.util"', '"/ranges.mjs"')
        .replaceAll('"./crypto.util"', '"/crypto.mjs"')
        .replaceAll('"./previewReadCache.util"', '"/readCache.mjs"'),
    ];
  const jpeg = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    path.join(__dirname, "fixtures/images/quadrants-lzw.tif"),
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-threads",
    "1",
    "pipe:1",
  ]);
  const rgb = new Uint8Array(64 * 48 * 3);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++)
      rgb.set(
        y < 24
          ? x < 32
            ? [220, 30, 30]
            : [30, 200, 30]
          : x < 32
            ? [30, 30, 220]
            : [240, 240, 240],
        (y * 64 + x) * 3,
      );
  const raws = {
    "/raw/jpeg": rawPreviewFixture(jpeg),
    "/raw/rgb": rawPreviewFixture(rgb, { jpeg: false }),
    "/raw/encrypted": rawPreviewFixture(jpeg),
  };
  const rawReads = {};
  const encryptionKey = randomBytes(32);
  const encryptedRecords = new Map();
  for (const name of fs.readdirSync(decoderDirectory)) {
    const type = name.endsWith(".wasm")
      ? "application/wasm"
      : /\.m?js$/.test(name)
        ? "text/javascript"
        : "text/plain";
    resources["/image-decoders/" + name] = [
      type,
      fs.readFileSync(path.join(decoderDirectory, name)),
    ];
  }
  const fixtures = path.join(__dirname, "fixtures/images");
  for (const name of fs.readdirSync(fixtures)) {
    resources["/fixtures/" + name] = [
      "application/octet-stream",
      fs.readFileSync(path.join(fixtures, name)),
    ];
  }
  const samples = [];
  if (process.env.IMAGE_DECODER_SAMPLES) {
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(location);
        else if (entry.isFile() && SAMPLE_EXTENSIONS.test(entry.name)) {
          const url = "/samples/" + samples.length;
          samples.push({ url, name: entry.name });
          resources[url] = [
            "application/octet-stream",
            fs.readFileSync(location),
          ];
        }
      }
    };
    walk(path.resolve(process.env.IMAGE_DECODER_SAMPLES));
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-image-decoder-"));
  let browser, server, send, session;
  let nextId = 0;
  const pending = new Map();
  const call = (method, params = {}, sessionId = session) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(method + " timeout"));
        },
        method === "Runtime.evaluate" ? 300000 : 30000,
      );
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  try {
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
    const requested = [];
    server = https.createServer(
      { key: fs.readFileSync(path.join(directory, "key.pem")), cert },
      (req, res) => {
        requested.push(req.url);
        const raw = raws[req.url];
        if (raw) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
          if (!match) {
            res.writeHead(400);
            res.end();
            return;
          }
          const start = Number(match[1]),
            end = Number(match[2]);
          const encrypted = req.url === "/raw/encrypted";
          const size =
            raw.size + (encrypted ? Math.ceil(raw.size / 1_000_000) * 28 : 0);
          if (start > end || end >= size) {
            res.writeHead(416);
            res.end();
            return;
          }
          let bytes;
          if (!encrypted) bytes = raw.read(start, end + 1);
          else {
            bytes = new Uint8Array(end - start + 1);
            for (let pos = start; pos <= end; ) {
              const index = Math.floor(pos / 1_000_028);
              if (!encryptedRecords.has(index)) {
                const iv = randomBytes(12),
                  cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
                encryptedRecords.set(
                  index,
                  Buffer.concat([
                    iv,
                    cipher.update(
                      raw.read(
                        index * 1_000_000,
                        Math.min(raw.size, (index + 1) * 1_000_000),
                      ),
                    ),
                    cipher.final(),
                    cipher.getAuthTag(),
                  ]),
                );
              }
              const record = encryptedRecords.get(index),
                within = pos - index * 1_000_028,
                length = Math.min(end - pos + 1, record.length - within);
              bytes.set(record.subarray(within, within + length), pos - start);
              pos += length;
            }
          }
          rawReads[req.url] = (rawReads[req.url] || 0) + bytes.length;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Cache-Control": "no-store",
            ...(encrypted ? { "X-Encryption-Chunk-Size": "1000000" } : {}),
          });
          setTimeout(
            () => res.end(bytes),
            Math.ceil((bytes.length / (10 * 1024 * 1024)) * 1000),
          );
          return;
        }
        const resource = resources[req.url];
        const headers = {
          "content-type": resource?.[0] || "text/plain",
          "cache-control": "no-store",
        };
        if (req.url === "/")
          headers["content-security-policy"] = documentPolicy;
        if (req.url === "/image-decoders/decoder.worker.js")
          headers["content-security-policy"] = workerPolicy;
        res.writeHead(resource ? 200 : 404, headers);
        res.end(resource?.[1] || "not found");
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
        "--remote-debugging-pipe",
        `--ignore-certificate-errors-spki-list=${pin}`,
        `--user-data-dir=${path.join(directory, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    send = createChromeProtocolPipe(browser, (message) => {
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
    await call("Page.navigate", { url: origin });
    const result = await call("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{
        for(let i=0;i<200&&!globalThis.clientReady;i++)await new Promise(r=>setTimeout(r,25));
        if(!globalThis.clientReady)throw new Error('client module blocked');
        // The document policy itself must keep refusing WebAssembly.
        let pageWasmBlocked=false;
        try{await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]))}catch{pageWasmBlocked=true}
        const render=async(url,type,maxSide)=>{
          const started=performance.now();
          const bytes=await (await fetch(url)).arrayBuffer();
          const blob=await toDisplayableImageBlob(bytes,type,undefined,maxSide);
          const image=new Image();const src=URL.createObjectURL(blob);image.src=src;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
          const context=canvas.getContext('2d');context.drawImage(image,0,0);URL.revokeObjectURL(src);
          const at=(x,y)=>[...context.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data];
          return {type:blob.type,width:canvas.width,height:canvas.height,ms:Math.round(performance.now()-started),
            corners:[at(.12,.16),at(.88,.16),at(.12,.84),at(.88,.84)]};
        };
        const fixtures={};
        for(const [name,type] of [['quadrants.heic','image/heic'],['quadrants-alpha.heic','image/heic'],
          ['quadrants-lzw.tif','image/tiff'],['quadrants-cmyk.tif','image/tiff'],['quadrants-jpeg.tif','image/tiff'],
          ['quadrants-alpha.tif','image/tiff'],['quadrants-orientation6.tif','image/tiff']])
          fixtures[name]=await render('/fixtures/'+name,type);
        const png=await (await fetch('/fixtures/quadrants-lzw.tif')).arrayBuffer();
        const untouched=await toDisplayableImageBlob(png,'image/png');
        let aborted=false;const controller=new AbortController();
        const waiting=toDisplayableImageBlob(await (await fetch('/fixtures/quadrants.heic')).arrayBuffer(),'image/heic',controller.signal);
        controller.abort();try{await waiting}catch(e){aborted=e.name==='AbortError'}
        let corruptRejected=false;
        try{await toDisplayableImageBlob(new Uint8Array([1,2,3,4]).buffer,'image/heic')}catch{corruptRejected=true}
        const rawResults=[];
        for(const url of ['/raw/jpeg','/raw/rgb','/raw/encrypted']){
          const started=performance.now();
          const key=url.endsWith('encrypted')?await importKeyFromBase64(${JSON.stringify(encryptionKey.toString("base64url"))}):undefined;
          const source=await createPreviewByteSource((start,end,signal)=>fetch(url,{headers:{Range:'bytes='+start+'-'+end},signal}),key);
          const preview=await readRawRangePreview(source);
          const blob=preview.kind==='jpeg'?await toDisplayableDecodedImageBlob(preview.decoded):await toDisplayableImageBlob(preview.bytes,'image/tiff');
          const image=new Image(),src=URL.createObjectURL(blob);image.src=src;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
          const context=canvas.getContext('2d');context.drawImage(image,0,0);URL.revokeObjectURL(src);
          const at=(x,y)=>[...context.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data];
          rawResults.push({url,width:canvas.width,height:canvas.height,ms:Math.round(performance.now()-started),corners:[at(.12,.16),at(.88,.16),at(.12,.84),at(.88,.84)]});
        }
        const samples=[];
        for(const sample of ${JSON.stringify(samples)}){
          const ext=sample.name.split('.').pop().toLowerCase();
          const type=ext==='heic'||ext==='heif'?'image/heic':ext.startsWith('tif')?'image/tiff':'image/x-adobe-dng';
          try{const r=await render(sample.url,type);samples.push({name:sample.name,type:r.type,width:r.width,height:r.height,ms:r.ms})}
          catch(e){samples.push({name:sample.name,error:String(e&&e.message||e)})}
        }
        return {rawResults,pageWasmBlocked,fixtures,untouched:untouched.type==='image/png'&&untouched.size===png.byteLength,aborted,corruptRejected,samples};
      })()`,
    });
    if (result.exceptionDetails)
      assert.fail(JSON.stringify(result.exceptionDetails));
    for (const preview of result.result.value.rawResults) {
      assert.deepEqual(
        [preview.width, preview.height],
        [48, 64],
        "DNG orientation is applied",
      );
      const expected = [
        [30, 30, 220],
        [220, 30, 30],
        [240, 240, 240],
        [30, 200, 30],
      ];
      preview.corners.forEach((color, i) =>
        color
          .slice(0, 3)
          .forEach((channel, j) =>
            assert.ok(
              Math.abs(channel - expected[i][j]) < 40,
              JSON.stringify(preview),
            ),
          ),
      );
      const bytes = rawReads[preview.url];
      assert.ok(
        bytes < (preview.url.endsWith("encrypted") ? 2_100_000 : 200_000),
      );
      console.log(
        JSON.stringify({
          scenario: "DNG ranged preview",
          ...preview,
          bytesRead: bytes,
          sourceBytes: 100 * 1024 * 1024,
        }),
      );
    }
    const value = result.result.value;
    assert.equal(value.pageWasmBlocked, true, "document CSP must refuse WASM");
    const near = (actual, expected, tolerance = 28) =>
      actual.every(
        (channel, index) => Math.abs(channel - expected[index]) <= tolerance,
      );
    const QUADRANTS = [
      [220, 30, 30, 255],
      [30, 200, 30, 255],
      [30, 30, 220, 255],
      [240, 240, 240, 255],
    ];
    for (const [name, image] of Object.entries(value.fixtures)) {
      const rotated = name.includes("orientation6");
      assert.deepEqual(
        [image.width, image.height],
        rotated ? [48, 64] : [64, 48],
        name,
      );
      // Orientation 6 turns the picture a quarter clockwise: blue now sits
      // top-left, red top-right, white bottom-left and green bottom-right.
      const expected = rotated
        ? [QUADRANTS[2], QUADRANTS[0], QUADRANTS[3], QUADRANTS[1]]
        : QUADRANTS.slice();
      if (name.includes("alpha")) {
        assert.equal(image.type, "image/png", name);
        expected[3] = [240, 240, 240, 96];
      } else assert.equal(image.type, "image/jpeg", name);
      image.corners.forEach((corner, index) =>
        assert.ok(
          near(corner, expected[index]),
          `${name} corner ${index}: ${corner}`,
        ),
      );
    }
    assert.equal(value.untouched, true, "browser formats must pass through");
    assert.equal(value.aborted, true);
    assert.equal(value.corruptRejected, true);
    assert.ok(requested.includes("/image-decoders/libheif.wasm"));
    console.log(
      `real Chrome: ${Object.keys(value.fixtures).length} HEIC/TIFF fixtures decoded under the production CSP, WASM refused to the page, abort and corrupt input handled`,
    );
    for (const sample of value.samples) {
      console.log(
        sample.error
          ? `  ${sample.name}: ${sample.error}`
          : `  ${sample.name}: ${sample.width}x${sample.height} ${sample.type} in ${sample.ms} ms`,
      );
    }
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
