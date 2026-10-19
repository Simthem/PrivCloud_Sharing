const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const { createCipheriv, createHash, X509Certificate } = require("node:crypto");
const ts = require("typescript");
const { zipSync, strToU8 } = require("fflate");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");
const officeFixtures = require("./fixtures/office-documents.cjs");
const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "privcloud-preview-browser-"),
);
const root = path.resolve(__dirname, "..");
let browser,
  server,
  send,
  nextId = 0;
const pending = new Map(),
  key = Buffer.alloc(32, 19),
  recordBytes = 1_000_000;
const reads = [],
  encryptedCache = new Map(),
  assets = new Map();
const stats = { requested: 0, wholeRequests: 0 };
function plainRange(asset, start, end) {
  const bytes = Buffer.alloc(end - start, asset.fill || 0);
  for (const part of asset.parts) {
    const a = Math.max(start, part.offset),
      b = Math.min(end, part.offset + part.bytes.length);
    if (a < b)
      part.bytes.copy(bytes, a - start, a - part.offset, b - part.offset);
  }
  return bytes;
}
function storedRange(name, start, end) {
  const asset = assets.get(name),
    result = Buffer.alloc(end - start + 1);
  for (let pos = start; pos <= end; ) {
    const index = Math.floor(pos / (recordBytes + 28)),
      id = `${name}:${index}`;
    let record = encryptedCache.get(id);
    if (!record) {
      const iv = Buffer.alloc(12);
      iv.writeUInt32BE(index, 8);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const plain = plainRange(
        asset,
        index * recordBytes,
        Math.min(asset.size, (index + 1) * recordBytes),
      );
      record = Buffer.concat([
        iv,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      encryptedCache.set(id, record);
      if (encryptedCache.size > 8)
        encryptedCache.delete(encryptedCache.keys().next().value);
    }
    const within = pos - index * (recordBytes + 28),
      length = Math.min(record.length - within, end - pos + 1);
    record.copy(result, pos - start, within, within + length);
    pos += length;
  }
  return result;
}
function call(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser timeout: ${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  });
}
async function wait(check, label) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const transpile = (name) =>
  ts
    .transpileModule(
      fs.readFileSync(path.join(root, "src/utils", name + ".ts"), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      },
    )
    .outputText.replaceAll('"./crypto.util"', '"/crypto.js"')
    .replaceAll('"./previewRange.util"', '"/ranges.js"')
    .replaceAll('"./previewReadCache.util"', '"/read-cache.js"')
    .replaceAll('"fflate"', '"/fflate.js"');
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
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const cert = fs.readFileSync(path.join(fixture, "cert.pem"));
    const tls = { key: fs.readFileSync(path.join(fixture, "key.pem")), cert };
    const certificatePin = createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=10",
      "-t",
      "120",
      "-c:v",
      "libx264",
      "-g",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path.join(fixture, "clip.mp4"),
    ]);
    const clip = fs.readFileSync(path.join(fixture, "clip.mp4")),
      padding = 300 * 1024 * 1024;
    const free = Buffer.alloc(8);
    free.writeUInt32BE(padding, 0);
    free.write("free", 4);
    assets.set("video", {
      size: clip.length + padding,
      parts: [
        { offset: 0, bytes: clip },
        { offset: clip.length, bytes: free },
      ],
    });
    const chunks = [Buffer.from("%PDF-1.7\n")],
      offsets = [0];
    let length = chunks[0].length;
    const stream = (text) => {
      const content = `BT /F1 20 Tf 30 350 Td (${text}) Tj ET\n`;
      return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
    };
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      stream("Hello"),
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
      stream("Second"),
    ];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(length);
      const bytes = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
      chunks.push(bytes);
      length += bytes.length;
    }
    offsets.push(length);
    chunks.push(
      Buffer.from(`8 0 obj\n<< /Length ${padding - length - 100} >>\nstream\n`),
    );
    const prefix = Buffer.concat(chunks),
      xref = Buffer.from(
        `xref\n0 9\n0000000000 65535 f \n${offsets
          .slice(1)
          .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
          .join(
            "",
          )}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${padding}\n%%EOF\n`,
      );
    assets.set("pdf", {
      size: padding + xref.length,
      parts: [
        { offset: 0, bytes: prefix },
        { offset: padding - 50, bytes: Buffer.from("\nendstream\nendobj\n") },
        { offset: padding, bytes: xref },
      ],
      fill: 10,
    });
    const odf = zipSync({
      mimetype: [
        strToU8("application/vnd.oasis.opendocument.text"),
        { level: 0 },
      ],
      "content.xml": strToU8(officeFixtures.odtXml),
      "Pictures/pixel.png": officeFixtures.png,
      "Pictures/unused.bin": [new Uint8Array(3 * 1024 * 1024), { level: 0 }],
    });
    assets.set("odt", {
      size: odf.length,
      parts: [{ offset: 0, bytes: Buffer.from(odf) }],
    });
    for (const name of ["docx", "xlsx", "pptx"]) {
      const bytes = officeFixtures.officePackage(
        officeFixtures[name],
        12 * 1024 * 1024,
      );
      assets.set(name, {
        size: bytes.length,
        parts: [{ offset: 0, bytes: Buffer.from(bytes) }],
      });
    }
    const XLSX = require("xlsx");
    for (const [name, bookType] of [
      ["xls", "biff8"],
      ["xlsb", "xlsb"],
    ]) {
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([
        ["Legacy budget", 0.375],
        ["<img src=x onerror=alert(1)>", 7],
      ]);
      sheet.B1.z = "0.00%";
      sheet.B2.f = "1+2";
      XLSX.utils.book_append_sheet(book, sheet, "Budget");
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([["Second legacy sheet"]]),
        "Détails",
      );
      const bytes = Buffer.from(XLSX.write(book, { bookType, type: "array" }));
      assets.set(name, { size: bytes.length, parts: [{ offset: 0, bytes }] });
    }
    const webpack = require(
      path.join(root, "node_modules/next/dist/compiled/webpack/webpack"),
    ).webpack;
    const write = (name, body) => {
      const target = path.join(fixture, name);
      fs.writeFileSync(target, body);
      return target;
    };
    const shareStub = write(
      "share-stub.js",
      "export const fetchFilePreviewSource=async(shareId,fileId,key,signal)=>window.source(fileId);",
    );
    const linkStub = write(
      "link-stub.js",
      "import React from 'react';export default React.forwardRef(function Link({href,children,...props},ref){return React.createElement('a',{...props,href,ref},children);});",
    );
    const routerStub = write(
      "router-stub.js",
      "export const useRouter=()=>({locale:'fr'});",
    );
    const metaStub = write(
      "meta-stub.js",
      "export default function Meta(){return null;}",
    );
    const teamStub = write(
      "team-stub.js",
      "export default {getKeyRotationStatus:async()=>window.rotationStatus};",
    );
    const loader = write(
      "loader.cjs",
      `const ts=require(${JSON.stringify(path.join(root, "node_modules/typescript"))});module.exports=function(source){return ts.transpileModule(source,{fileName:this.resourcePath,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;};`,
    );
    const cssLoader = write(
      "css-loader.cjs",
      "module.exports=function(source){const classes={};for(const match of source.matchAll(/\\.([a-zA-Z][a-zA-Z0-9_-]*)/g))classes[match[1]]=match[1];return 'export default '+JSON.stringify(classes)+';';};",
    );
    write(
      "office.css",
      fs.readFileSync(
        path.join(root, "src/components/share/OfficePreview.module.css"),
      ),
    );
    write(
      "mantine.css",
      fs.readFileSync(path.join(root, "node_modules/@mantine/core/styles.css")),
    );
    const entry = write(
      "entry.tsx",
      `
import React from 'react';import {createRoot} from 'react-dom/client';import {MantineProvider} from '@mantine/core';import {IntlProvider} from 'react-intl';
import Zoom from ${JSON.stringify(path.join(root, "src/components/share/ZoomablePreview.tsx"))};
import Pdf from ${JSON.stringify(path.join(root, "src/components/share/ProgressivePdfPreview.tsx"))};import Office from ${JSON.stringify(path.join(root, "src/components/share/OfficePreview.tsx"))};
import Rotation from ${JSON.stringify(path.join(root, "src/components/team/TeamRotationSchedule.tsx"))};
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import messages from ${JSON.stringify(path.join(root, "src/i18n/translations/fr-FR.ts"))};
const root=createRoot(document.getElementById('root'));window.uiErrors=[];const onError=()=>window.uiErrors.push('preview failed');
window.showZoom=()=>root.render(<MantineProvider deduplicateCssVariables={false}><IntlProvider locale='fr' messages={messages}><Zoom><img alt='zoom fixture' draggable={false} style={{width:'100%',display:'block'}} src='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1000" height="1200"%3E%3Crect width="1000" height="1200" fill="teal"/%3E%3C/svg%3E'/></Zoom></IntlProvider></MantineProvider>);
window.showPdf=()=>root.render(<MantineProvider deduplicateCssVariables={false}><IntlProvider locale='fr'><Pdf shareId='fixture' fileId='pdf' e2eKey='fixture' onError={onError}/></IntlProvider></MantineProvider>);
window.showOffice=(name='odt')=>root.render(<MantineProvider deduplicateCssVariables={false}><IntlProvider locale='fr'><Office key={name} shareId='fixture' fileId={name} mimeType={name==='xls'?'application/vnd.ms-excel':name==='xlsb'?'application/vnd.ms-excel.sheet.binary.macroenabled.12':''} e2eKey='fixture' onError={onError}/></IntlProvider></MantineProvider>);
window.showRotation=(mode='upcoming')=>{window.rotationStatus={policy:{nextDueAt:new Date(Date.now()+5*86400000).toISOString(),isDue:mode==='due',reminderActive:mode==='due'},activeRotation:mode==='paused'?{status:'PAUSED',processedFiles:2,totalFiles:5}:null};const client=new QueryClient();root.render(<MantineProvider deduplicateCssVariables={false}><IntlProvider locale='fr' messages={messages}><QueryClientProvider key={mode} client={client}><Rotation teamId='fixture-team'/></QueryClientProvider></IntlProvider></MantineProvider>);};window.uiReady=true;`,
    );
    await new Promise((resolve, reject) =>
      webpack(
        {
          mode: "development",
          devtool: false,
          entry,
          output: { path: fixture, filename: "bundle.js", publicPath: "/ui/" },
          plugins: [
            new webpack.DefinePlugin({
              "process.env.BUILD_TARGET": JSON.stringify(""),
              "process.env.NEXT_PUBLIC_API_ORIGIN": JSON.stringify(""),
            }),
            new webpack.NormalModuleReplacementPlugin(/^next\/link$/, linkStub),
            new webpack.NormalModuleReplacementPlugin(
              /^next\/router$/,
              routerStub,
            ),
            new webpack.NormalModuleReplacementPlugin(
              /(?:^|\/)Meta(?:\.tsx)?$/,
              metaStub,
            ),
            new webpack.NormalModuleReplacementPlugin(
              /(?:^|\/)team\.service(?:\.ts)?$/,
              teamStub,
            ),
            new webpack.NormalModuleReplacementPlugin(
              /(?:^|\/)(share\.service)(?:\.ts)?$/,
              shareStub,
            ),
          ],
          resolve: {
            extensions: [".ts", ".tsx", ".js"],
            modules: [path.join(root, "node_modules"), "node_modules"],
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
                error ||
                  new Error(stats.toString({ all: false, errors: true })),
              )
            : resolve(),
      ),
    );
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui/office.css"><link rel="stylesheet" href="/ui/mantine.css"></head><body><video controls muted preload="metadata"></video><canvas></canvas><div id="root" style="width:min(100%, 1000px)"></div><script src="/ui/bundle.js"></script><script type="module">
import {importKeyFromBase64} from '/crypto.js';import {createPreviewByteSource,readPreviewBytes} from '/ranges.js';import {createProgressiveMediaUrl} from '/media.js';import {openPreviewZip,parseOfficeContent} from '/office.js';import * as pdfjs from '/pdf.mjs';
window.key=await importKeyFromBase64('${key.toString("base64url")}');window.source=async name=>createPreviewByteSource(async(start,end,signal)=>fetch('/file/'+name,{headers:{Range:'bytes='+start+'-'+end,Authorization:'Bearer fixture'},signal}),window.key);
window.mediaAbort=new AbortController();const source=await window.source('video');const media=await createProgressiveMediaUrl(source,'video/mp4',window.mediaAbort.signal);window.mediaUrl=media.url;document.querySelector('video').src=media.url;window.ready=true;
window.previewPdf=async()=>{const source=await window.source('pdf');const transport=new pdfjs.PDFDataRangeTransport(source.size,await readPreviewBytes(source,0,Math.min(source.size,65536)),true);transport.requestDataRange=(a,b)=>readPreviewBytes(source,a,b).then(bytes=>transport.onDataRange(a,bytes));pdfjs.GlobalWorkerOptions.workerSrc='/pdf.worker.min.mjs';const task=pdfjs.getDocument({range:transport,disableAutoFetch:true,disableStream:true,rangeChunkSize:65536,isEvalSupported:false});const doc=await task.promise;const page=await doc.getPage(2);const canvas=document.querySelector('canvas');const viewport=page.getViewport({scale:1});canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const content=await page.getTextContent();const result={pages:doc.numPages,text:content.items.map(i=>i.str).join('')};await doc.destroy();return result;};
window.previewOffice=async()=>{const zip=await openPreviewZip(await window.source('odt'),new AbortController().signal);const xml=await zip.read('content.xml');return parseOfficeContent(new TextDecoder().decode(xml),new DOMParser());};
</script></body></html>`;
    const uiAssets = new Map(
      fs
        .readdirSync(fixture, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && /^[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(entry.name),
        )
        .map((entry) => [
          `/ui/${entry.name}`,
          {
            contentType: entry.name.endsWith(".css")
              ? "text/css"
              : "application/javascript",
            body: fs.readFileSync(path.join(fixture, entry.name)),
          },
        ]),
    );
    server = https.createServer(tls, (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      const route = req.url.split("?")[0];
      if (route === "/api/upload-fixture") {
        res.setHeader("Content-Type", "application/json");
        let received = 0;
        req.on("data", (chunk) => {
          received += chunk.length;
        });
        req.on("end", () => {
          if (
            req.method !== "POST" ||
            received !== Buffer.byteLength("fixture-upload")
          ) {
            res.writeHead(400);
            res.end('{"accepted":false}');
            return;
          }
          res.end('{"accepted":true}');
        });
        return;
      }
      if (route === "/foreign") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<script type="module">import {createProgressiveMediaUrl} from "/media.js";await createProgressiveMediaUrl({size:10,read:async(a,b)=>new Uint8Array(b-a)},"video/mp4",new AbortController().signal);window.ready=true;</script>',
        );
        return;
      }

      if (route.startsWith("/file/")) {
        const name = route.slice(6),
          asset = assets.get(name);
        if (!asset || req.headers.authorization !== "Bearer fixture") {
          res.writeHead(401);
          res.end();
          return;
        }
        const storedSize =
            asset.size + Math.ceil(asset.size / recordBytes) * 28,
          match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
        if (!match) {
          stats.wholeRequests++;
          res.writeHead(400);
          res.end();
          return;
        }
        const start = Number(match[1]),
          end = Number(match[2]);
        reads.push({ name, start, end });
        stats.requested += end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${storedSize}`,
          "X-Encryption-Chunk-Size": recordBytes,
          "Content-Length": end - start + 1,
          "Cache-Control": "no-store",
        });
        res.end(storedRange(name, start, end));
        return;
      }
      const uiAsset = uiAssets.get(route);
      if (uiAsset) {
        res.setHeader("Content-Type", uiAsset.contentType);
        res.end(uiAsset.body);
        return;
      }
      const files = {
        "/sw.js": path.join(root, "public/sw.js"),
        "/preview-sw.js": path.join(root, "public/preview-sw.js"),
        "/fflate.js": path.join(root, "node_modules/fflate/esm/browser.js"),
        "/pdf.mjs": path.join(root, "node_modules/pdfjs-dist/build/pdf.mjs"),
        "/pdf.worker.min.mjs": path.join(
          root,
          "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
        ),
      };
      if (route === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end(page);
        return;
      }
      if (files[route]) {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(fs.readFileSync(files[route]));
        return;
      }
      const modules = {
        "/crypto.js": "crypto.util",
        "/ranges.js": "previewRange.util",
        "/read-cache.js": "previewReadCache.util",
        "/media.js": "previewMedia.util",
        "/office.js": "officePreview.util",
      };
      if (modules[route]) {
        res.setHeader("Content-Type", "application/javascript");
        res.end(transpile(modules[route]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `https://127.0.0.1:${server.address().port}`;
    browser = spawn(
      process.env.CHROME_PATH || "/usr/bin/google-chrome",
      [
        "--headless=new",
        `--ignore-certificate-errors-spki-list=${certificatePin}`,
        "--disable-gpu",
        "--no-first-run",
        "--disable-background-networking",
        "--autoplay-policy=no-user-gesture-required",
        "--remote-debugging-pipe",
        `--user-data-dir=${path.join(fixture, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
    send = createChromeProtocolPipe(browser, (message) => {
      if (message.method === "Runtime.exceptionThrown")
        console.error("Preview browser reported an uncaught exception");
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error
        ? entry.reject(new Error(message.error.message))
        : entry.resolve(message.result);
    });
    const { targetId } = await call("Target.createTarget", {
        url: "about:blank",
      }),
      { sessionId } = await call("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
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
    await call("Page.navigate", { url: origin }, sessionId);
    await wait(() => evaluate("window.ready === true"), "preview worker ready");
    assert.equal(
      await evaluate(
        "location.protocol === 'https:' && window.isSecureContext",
      ),
      true,
    );
    assert.equal(
      await evaluate(`(async () => {
        const channel = new MessageChannel();
        let answered = false;
        channel.port1.onmessage = () => { answered = true; };
        navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
          origin: location.origin, source: navigator.serviceWorker.controller,
          data: {type: 'privcloud-preview', token: window.mediaUrl.split('/').pop()},
          ports: [channel.port2]
        }));
        await new Promise(resolve => setTimeout(resolve, 50));
        channel.port1.close(); channel.port2.close();
        return answered;
      })()`),
      false,
    );
    console.log("worker ready");
    await wait(
      () => evaluate("document.querySelector('video').readyState >= 2"),
      "video metadata and first frame",
    );
    console.log("video frame", stats);
    assert.ok(
      stats.requested < 15 * 1024 * 1024,
      `first frame read ${stats.requested} bytes`,
    );
    assert.equal(
      await evaluate("document.querySelector('video').duration"),
      120,
    );
    await evaluate("document.querySelector('video').currentTime=110");
    await wait(
      () =>
        evaluate(
          "!document.querySelector('video').seeking && document.querySelector('video').readyState>=2",
        ),
      "video seek",
    );
    await evaluate("document.querySelector('video').play()");
    await wait(
      () => evaluate("document.querySelector('video').currentTime > 110.5"),
      "video playback",
    );
    assert.equal(
      await evaluate(
        "fetch('/api/upload-fixture',{method:'POST',body:'fixture-upload'}).then(r=>r.json()).then(r=>r.accepted)",
      ),
      true,
    );
    const uploadProbe = await evaluate(
      "fetch('/api/upload-fixture',{method:'POST',body:'<svg/onload=1>'}).then(async r=>({status:r.status,type:r.headers.get('Content-Type'),nosniff:r.headers.get('X-Content-Type-Options'),body:await r.text()}))",
    );
    assert.equal(uploadProbe.status, 200);
    assert.equal(uploadProbe.type, "application/json");
    assert.equal(uploadProbe.nosniff, "nosniff");
    assert.equal(uploadProbe.body, '{"accepted":true}');
    console.log("seek and playback passed");
    const partial = await evaluate(
      "fetch(window.mediaUrl,{headers:{Range:'bytes=314000000-314000009'}}).then(async r=>({status:r.status,length:(await r.arrayBuffer()).byteLength}))",
    );
    assert.equal(partial.status, 206);
    assert.equal(partial.length, 10);
    assert.equal(
      await evaluate(
        "fetch(window.mediaUrl,{headers:{Range:'bytes=9999999999-'}}).then(r=>r.status)",
      ),
      416,
    );
    await evaluate(
      "document.querySelector('video').pause();document.querySelector('video').removeAttribute('src');document.querySelector('video').load()",
    );
    console.log("ranges passed");
    // A forced reload (Ctrl+Shift+R) leaves the page uncontrolled: the page
    // must have the active worker claim it again instead of timing out.
    await call("Page.reload", { ignoreCache: true }, sessionId);
    await wait(
      () => evaluate("window.ready === true"),
      "preview worker after a forced reload",
    );
    assert.equal(await evaluate("!!navigator.serviceWorker.controller"), true);
    await wait(
      () => evaluate("document.querySelector('video').readyState >= 2"),
      "video frame after a forced reload",
    );
    console.log("forced reload passed");
    const pdf = await evaluate("window.previewPdf()");
    assert.equal(pdf.pages, 2);
    assert.match(pdf.text, /Second/);
    console.log("pdf passed", pdf);
    const office = await evaluate("window.previewOffice()");
    assert.equal(office.blocks[0].text, "ODT fixture");
    await wait(() => evaluate("window.uiReady === true"), "UI bundle ready");
    await evaluate("window.showPdf()");
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root canvas')?.width>0 && !document.querySelector('[aria-label=\"Next page\"]')?.disabled",
        ),
      "PDF UI first page",
    );
    await evaluate(
      "document.querySelector('[aria-label=\"Next page\"]').click()",
    );
    await wait(
      () =>
        evaluate(
          "document.querySelector('[aria-label=\"PDF page\"]')?.value==='2' && !document.querySelector('[aria-label=\"Previous page\"]')?.disabled",
        ),
      "PDF UI page navigation",
    );
    const initialPdf = await evaluate(
      "document.querySelector('#root canvas').width",
    );
    await evaluate(
      "document.querySelector('[aria-label=\"Zoom in\"]').click()",
    );
    await wait(
      () =>
        evaluate(
          `document.querySelector('#root canvas').width>${initialPdf} && !document.querySelector('[aria-label="Previous page"]').disabled`,
        ),
      "PDF zoom rerenders more pixels",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-label=\"PDF page\"]').value",
      ),
      "2",
      "zoom retains PDF page",
    );
    await evaluate("window.showZoom()");
    await wait(
      () =>
        evaluate(
          "document.querySelector('[data-document-viewport] img')?.complete",
        ),
      "image zoom ready",
    );
    await evaluate("document.querySelector('[aria-label=\"Zoomer\"]').click()");
    assert.equal(
      await evaluate(
        "document.querySelector('[data-document-viewport] > div').style.width",
      ),
      "125%",
    );
    await evaluate(
      "document.querySelector('[data-document-viewport]').focus()",
    );
    await call(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "+", code: "Equal" },
      sessionId,
    );
    await call(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "+", code: "Equal" },
      sessionId,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('[data-document-viewport] > div').style.width",
      ),
      "156.25%",
    );
    await evaluate(
      "[...document.querySelectorAll('#root button')].find(e=>e.textContent==='Ajuster').click()",
    );
    await call(
      "Emulation.setTouchEmulationEnabled",
      { enabled: true },
      sessionId,
    );
    const area = await evaluate(
      "(()=>{const r=document.querySelector('[data-document-viewport]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+120}})()",
    );
    await call(
      "Input.dispatchTouchEvent",
      {
        type: "touchStart",
        touchPoints: [
          { x: area.x - 50, y: area.y, id: 1 },
          { x: area.x + 50, y: area.y, id: 2 },
        ],
      },
      sessionId,
    );
    await call(
      "Input.dispatchTouchEvent",
      {
        type: "touchMove",
        touchPoints: [
          { x: area.x - 100, y: area.y, id: 1 },
          { x: area.x + 100, y: area.y, id: 2 },
        ],
      },
      sessionId,
    );
    await call(
      "Input.dispatchTouchEvent",
      { type: "touchEnd", touchPoints: [] },
      sessionId,
    );
    await wait(
      () =>
        evaluate(
          "parseFloat(document.querySelector('[data-document-viewport] > div').style.width)>180",
        ),
      "touch pinch enlarges image",
    );
    const beforeWheel = await evaluate(
      "parseFloat(document.querySelector('[data-document-viewport] > div').style.width)",
    );
    await call(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: area.x,
        y: area.y,
        deltaX: 0,
        deltaY: -40,
        modifiers: 2,
      },
      sessionId,
    );
    await wait(
      () =>
        evaluate(
          `parseFloat(document.querySelector('[data-document-viewport] > div').style.width)>${beforeWheel}`,
        ),
      "Ctrl-wheel zoom without browser scrolling",
    );
    const beforePan = await evaluate(
      "document.querySelector('[data-document-viewport]').scrollTop",
    );
    await call(
      "Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: [{ x: area.x, y: area.y, id: 1 }] },
      sessionId,
    );
    await call(
      "Input.dispatchTouchEvent",
      {
        type: "touchMove",
        touchPoints: [{ x: area.x, y: area.y - 60, id: 1 }],
      },
      sessionId,
    );
    await call(
      "Input.dispatchTouchEvent",
      { type: "touchEnd", touchPoints: [] },
      sessionId,
    );
    assert.ok(
      (await evaluate(
        "document.querySelector('[data-document-viewport]').scrollTop",
      )) > beforePan,
      "touch pans enlarged document",
    );
    await call(
      "Emulation.setTouchEmulationEnabled",
      { enabled: false },
      sessionId,
    );
    console.log(
      "image/PDF zoom buttons, keyboard, pinch, pan and PDF page retention passed",
    );
    await evaluate("window.showOffice()");
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root')?.textContent.includes('Encrypted local document')",
        ),
      "ODT UI content",
    );
    await wait(
      () => evaluate("document.querySelector('#root img')?.naturalWidth === 1"),
      "ODT local image",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('#root h1 span')).color",
      ),
      "rgb(34, 85, 170)",
    );
    await evaluate("window.showOffice('docx')");
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root h1')?.textContent === 'DOCX report'",
        ),
      "DOCX heading",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle([...document.querySelectorAll('#root span')].find(n => n.textContent === 'Styled text')).fontWeight",
      ),
      "700",
    );
    assert.equal(
      await evaluate("document.querySelector('#root td').colSpan"),
      2,
    );
    await wait(
      () => evaluate("document.querySelector('#root img')?.naturalWidth === 1"),
      "DOCX embedded image",
    );
    const screenshot = async (name) => {
      if (!process.env.PREVIEW_SCREENSHOT_DIR) return;
      await evaluate(
        "document.querySelector('video').style.display='none';document.querySelector('body > canvas').style.display='none'",
      );
      fs.mkdirSync(process.env.PREVIEW_SCREENSHOT_DIR, { recursive: true });
      const result = await call(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true },
        sessionId,
      );
      fs.writeFileSync(
        path.join(process.env.PREVIEW_SCREENSHOT_DIR, name + ".png"),
        Buffer.from(result.data, "base64"),
      );
    };
    await screenshot("docx");
    await evaluate("window.showOffice('xlsx')");
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root table')?.textContent.includes('Annual budget')",
        ),
      "XLSX first sheet",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('#root td')).backgroundColor",
      ),
      "rgb(34, 85, 170)",
    );
    assert.equal(
      await evaluate("document.querySelector('#root td').colSpan"),
      2,
    );
    assert.match(
      await evaluate("document.querySelector('#root table').textContent"),
      /37,50/,
    );
    await screenshot("xlsx");
    await evaluate(
      "document.querySelector('[aria-label=\"Feuille\"]').click()",
    );
    await wait(
      () =>
        evaluate(
          "[...document.querySelectorAll('[role=option]')].some(n=>n.textContent==='Détails')",
        ),
      "worksheet choices",
    );
    await evaluate(
      "[...document.querySelectorAll('[role=option]')].find(n=>n.textContent==='Détails').click()",
    );
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root table')?.textContent.includes('Second sheet')",
        ),
      "XLSX second sheet",
    );
    assert.equal(
      await evaluate("document.querySelector('#root table img') !== null"),
      false,
    );
    for (const name of ["xls", "xlsb"]) {
      await evaluate(`window.showOffice('${name}')`);
      await wait(
        () =>
          evaluate(
            "document.querySelector('#root table')?.textContent.includes('Legacy budget')",
          ),
        `${name} worker first sheet`,
      );
      assert.match(
        await evaluate("document.querySelector('#root table').textContent"),
        /37.50%/,
      );
      assert.match(
        await evaluate("document.querySelector('#root table').textContent"),
        /<img src=x onerror/,
      );
      assert.equal(
        await evaluate("document.querySelector('#root table img') !== null"),
        false,
      );
      await screenshot(name);
      await evaluate(
        "document.querySelector('[aria-label=\"Feuille\"]').click()",
      );
      await wait(
        () =>
          evaluate(
            "[...document.querySelectorAll('[role=option]')].some(n=>n.textContent==='Détails')",
          ),
        `${name} worksheet choices`,
      );
      await evaluate(
        "[...document.querySelectorAll('[role=option]')].find(n=>n.textContent==='Détails').click()",
      );
      await wait(
        () =>
          evaluate(
            "document.querySelector('#root table')?.textContent.includes('Second legacy sheet')",
          ),
        `${name} worker second sheet`,
      );
    }
    await evaluate("window.showOffice('pptx')");
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root .shape')?.textContent==='Local presentation'",
        ),
      "PPTX first slide",
    );
    await wait(
      () => evaluate("document.querySelector('#root img')?.naturalWidth === 1"),
      "PPTX local image",
    );
    assert.equal(
      await evaluate("document.querySelector('#root .shape').style.left"),
      "96px",
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('#root .slide')).backgroundColor",
      ),
      "rgb(247, 250, 255)",
    );
    await screenshot("pptx");
    await evaluate(
      "[...document.querySelectorAll('#root button')].find(n=>n.textContent==='Suivante').click()",
    );
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root .shape')?.textContent==='Second slide'",
        ),
      "PPTX navigation",
    );
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    await wait(
      () =>
        evaluate(
          "document.querySelector('#root .slide')?.getBoundingClientRect().width <= 390",
        ),
      "mobile slide fit",
    );
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= 390"),
      true,
    );
    await screenshot("pptx-mobile");
    for (const [mode, expected] of [
      ["upcoming", "dans 5 jours"],
      ["due", "à effectuer"],
      ["paused", "en pause : 2 / 5"],
    ]) {
      await evaluate(`window.showRotation('${mode}')`);
      await wait(
        () =>
          evaluate(
            `document.querySelector('#root')?.textContent.includes('${expected}')`,
          ),
        `rotation ${mode}`,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('#root a').getAttribute('href')",
        ),
        // The team page focuses its rotation controls on this anchor.
        "/team/fixture-team#e2e-rotation",
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth <= 390"),
        true,
      );
    }
    await screenshot("team-rotation-mobile");
    assert.deepEqual(await evaluate("window.uiErrors"), []);
    assert.equal(stats.wholeRequests, 0);
    assert.ok(
      stats.requested < 64 * 1024 * 1024,
      `preview read ${stats.requested} bytes`,
    );
    assert.ok(
      reads.some(
        (r) => r.name === "pdf" && r.start > 300 * 1024 * 1024 - recordBytes,
      ),
    );
    const foreignTarget = await call("Target.createTarget", {
      url: origin + "/foreign",
    });
    const foreignSession = await call("Target.attachToTarget", {
      targetId: foreignTarget.targetId,
      flatten: true,
    });
    await wait(async () => {
      const r = await call(
        "Runtime.evaluate",
        { expression: "window.ready===true", returnByValue: true },
        foreignSession.sessionId,
      );
      return r.result.value;
    }, "foreign client ready");
    const mainUrl = await evaluate("window.mediaUrl");
    const foreignResponse = await call(
      "Runtime.evaluate",
      {
        expression: `fetch(${JSON.stringify(mainUrl)},{headers:{Range:'bytes=0-9'}}).then(r=>r.status)`,
        returnByValue: true,
        awaitPromise: true,
      },
      foreignSession.sessionId,
    );
    assert.equal(foreignResponse.result.value, 503);

    await evaluate(
      "window.mediaAbort.abort();document.querySelector('video').pause();document.querySelector('video').removeAttribute('src');document.querySelector('video').load()",
    );
    assert.equal(
      await evaluate(
        "fetch(window.mediaUrl,{headers:{Range:'bytes=0-9'}}).then(r=>r.status)",
      ),
      503,
    );
    assert.equal(await evaluate("caches.keys().then(names=>names.length)"), 0);
    console.log(
      JSON.stringify(
        {
          passed: true,
          videoPlainBytes: assets.get("video").size,
          pdfPlainBytes: assets.get("pdf").size,
          requestedBytes: stats.requested,
          rangeRequests: reads.length,
          checks: [
            "first-frame-before-full-download",
            "seek",
            "playback",
            "plaintext-range",
            "416",
            "PDF-page-2",
            "PDF-UI-navigation",
            "ODT-content",
            "ODT-UI",
            "DOCX-styles-and-images",
            "XLSX-styles-and-sheet-navigation",
            "XLS-XLSB-encrypted-worker-and-sheet-navigation",
            "PPTX-layout-and-slide-navigation",
            "mobile-slide-fit",
            "rotation-countdown-due-and-paused-states",
            "authorization",
            "session-release",
            "no-cache",
            "API-upload-bypass",
            "foreign-client-isolation",
            "HTTPS-secure-context",
            "synthetic-message-rejection",
            "upload-body-not-reflected",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    browser?.kill("SIGTERM");
    await new Promise((resolve) =>
      server ? server.close(resolve) : resolve(),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
