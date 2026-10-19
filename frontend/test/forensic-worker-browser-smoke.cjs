const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const https = require("node:https")
const { spawn, execFileSync } = require("node:child_process")
const { createHash, X509Certificate } = require("node:crypto")
const ts = require("typescript")
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs")

async function main() {
  const root = path.resolve(__dirname, "..")
  const chunks = path.join(root, ".next/static/chunks")
  const workerPaths = fs
    .readdirSync(chunks)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(chunks, name))
    .filter((file) => {
      const source = fs.readFileSync(file, "utf8")
      return (
        source.includes("Candidate budget exceeded") &&
        source.includes('type:"ready"') &&
        source.includes(".onmessage=")
      )
    })
  assert.equal(
    workerPaths.length,
    1,
    "Build first: expected one production analysis worker",
  )
  const worker = fs.readFileSync(workerPaths[0])
  // The production worker can import shared webpack chunks. Preload owned
  // immutable assets instead of resolving a request URL into a filesystem path.
  const sharedChunks = {}
  let chunkBytes = 0
  for (const name of fs.readdirSync(chunks)) {
    if (name.length > 128 || !/^[a-f0-9]+(?:[.-][a-f0-9]+)+\.js$/.test(name))
      continue
    const location = path.join(chunks, name)
    const stat = fs.lstatSync(location)
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024,
    )
    chunkBytes += stat.size
    assert.ok(chunkBytes <= 64 * 1024 * 1024)
    sharedChunks["/_next/static/chunks/" + name] = [
      "text/javascript",
      fs.readFileSync(location),
    ]
  }
  const photoCondition = process.env.FORENSIC_LAB_PHOTO
  const cameraCondition = process.env.FORENSIC_CAMERA_CONTROL
  assert.ok(!cameraCondition || ["coarse", "visible"].includes(cameraCondition))
  assert.ok(!photoCondition || ["front", "angle"].includes(photoCondition))
  let photoPdf, photoCandidates
  let cameraPhoto, cameraCandidates, wrongCameraCandidates
  const transpile = (relative) =>
    ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText
  const suspectModule = transpile("src/utils/suspectImages.util.ts").replace(
    'import("pdfjs-dist")',
    'import("/pdfjs.mjs")',
  )
  const decisionModule = transpile("src/utils/forensicDecision.util.ts")
  const visibleModule = transpile("src/utils/visibleCopyMark.util.ts")
    .replace('"qrcode-generator"', '"/qrcode.mjs"')
    .replace('"jsqr"', '"/jsqr.mjs"')
  const qrEncoder = fs.readFileSync(
    path.join(root, "node_modules/qrcode-generator/dist/qrcode.mjs"),
    "utf8",
  )
  const qrDecoder =
    "const module={exports:{}};const exports=module.exports;\n" +
    fs.readFileSync(path.join(root, "node_modules/jsqr/dist/jsQR.js"), "utf8") +
    "\nexport default module.exports;"
  // Use the actual client utility, transpiled without behavioral changes, and
  // the production worker chunk. Only their fixture URLs differ from deployment.
  const utility = ts.transpileModule(
    fs.readFileSync(
      path.join(root, "src/utils/forensicAnalysis.util.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText
  const markModule = ts.transpileModule(
    fs.readFileSync(path.join(root, "src/utils/forensicMark.util.ts"), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pc-forensic-browser-"),
  )
  let browser,
    server,
    send,
    session,
    nextId = 0
  const pending = new Map()
  const call = (method, params = {}, sessionId = session) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(
        () => {
          pending.delete(id)
          reject(new Error(method + " timeout"))
        },
        method === "Runtime.evaluate" ? 180000 : 30000,
      )
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    })
  try {
    const { markPattern, embedMark } = await import(
      path.join(root, "src/utils/forensicMark.util.ts")
    )
    if (cameraCondition) {
      const location = path.join(
        os.homedir(),
        "Téléchargements",
        cameraCondition === "coarse" ? "52542.jpg" : "52540.jpg",
      )
      const stat = fs.lstatSync(location)
      assert.ok(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size <= 64 * 1024 * 1024,
      )
      cameraPhoto = fs.readFileSync(location)
      const sha = (value) => createHash("sha256").update(value).digest("hex")
      const key = new Uint8Array(
        Buffer.from(sha("privcloud-photo-laboratory-v1"), "hex"),
      )
      const { visibleCopyToken } = await import(
        path.join(root, "src/utils/visibleCopyMark.util.ts")
      )
      const derive = (teamKey) =>
        Promise.all(
          Array.from({ length: 8 }, async (_, index) => {
            const markId = sha(
              "privcloud-photo-laboratory-copy:" + index,
            ).slice(0, 32)
            return {
              markId,
              pattern: [...(await markPattern(teamKey, markId))],
              ...(cameraCondition === "coarse"
                ? { robust: true }
                : { visibleToken: await visibleCopyToken(teamKey, markId) }),
            }
          }),
        )
      cameraCandidates = await derive(key)
      wrongCameraCandidates = await derive(new Uint8Array(32).fill(127))
    }
    if (photoCondition) {
      const photoDirectory = path.resolve(
        root,
        "../../Preuves_Tests/forensic-photo-2026-10-13",
      )
      const names = fs
        .readdirSync(photoDirectory)
        .filter(
          (name) =>
            /^photo-recalee-a-(front|angle)-\d+\.pdf$/.test(name) &&
            name.includes("a-" + photoCondition + "-"),
        )
      assert.ok(names.length)
      const location = path.join(photoDirectory, names.sort().at(-1))
      const stat = fs.lstatSync(location)
      assert.ok(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size <= 64 * 1024 * 1024,
      )
      photoPdf = fs.readFileSync(location)
      const sha = (value) => createHash("sha256").update(value).digest("hex")
      const key = new Uint8Array(
        Buffer.from(sha("privcloud-photo-laboratory-v1"), "hex"),
      )
      photoCandidates = await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const markId = sha("privcloud-photo-laboratory-copy:" + index).slice(
            0,
            32,
          )
          return { markId, pattern: [...(await markPattern(key, markId))] }
        }),
      )
    }
    const markId = "1".repeat(32)
    const pattern = await markPattern(new Uint8Array(32).fill(17), markId)
    const otherId = "2".repeat(32)
    const otherPattern = await markPattern(new Uint8Array(32).fill(17), otherId)
    const mixed = {
      width: 512,
      height: 512,
      data: new Uint8ClampedArray(512 * 512 * 4).fill(180),
    }
    for (let offset = 3; offset < mixed.data.length; offset += 4)
      mixed.data[offset] = 255
    const other = { ...mixed, data: new Uint8ClampedArray(mixed.data) }
    embedMark(mixed, pattern)
    embedMark(other, otherPattern)
    for (let offset = 0; offset < mixed.data.length; offset++)
      mixed.data[offset] = (mixed.data[offset] + other.data[offset]) / 2
    const pixels = {
      width: 1920,
      height: 1440,
      data: new Uint8ClampedArray(1920 * 1440 * 4).fill(255),
    }
    embedMark(pixels, pattern)
    if (!photoCondition) {
      const { PDFDocument } = require("pdf-lib")
      const sharp = require("sharp")
      const document = await PDFDocument.create()
      const png = await sharp(Buffer.from(pixels.data), {
        raw: { width: pixels.width, height: pixels.height, channels: 4 },
      })
        .png()
        .toBuffer()
      const image = await document.embedPng(png)
      for (let page = 0; page < 2; page++)
        document
          .addPage([480, 360])
          .drawImage(image, { x: 0, y: 0, width: 480, height: 360 })
      photoPdf = Buffer.from(await document.save())
      photoCandidates = [{ markId, pattern: [...pattern] }]
    }
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
    )
    const cert = fs.readFileSync(path.join(directory, "cert.pem"))
    const pin = createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64")
    server = https.createServer(
      { key: fs.readFileSync(path.join(directory, "key.pem")), cert },
      (req, res) => {
        const resources = {
          ...sharedChunks,
          "/": [
            "text/html",
            "<!doctype html><title>Local forensic worker test</title>",
          ],
          "/analyzer.mjs": ["text/javascript", utility],
          "/forensicMark.util": ["text/javascript", markModule],
          "/visibleCopyMark.util": ["text/javascript", visibleModule],
          "/qrcode.mjs": ["text/javascript", qrEncoder],
          "/jsqr.mjs": ["text/javascript", qrDecoder],
          "/suspect.mjs": ["text/javascript", suspectModule],
          "/decision.mjs": ["text/javascript", decisionModule],
          "/pdfjs.mjs": [
            "text/javascript",
            fs.readFileSync(
              path.join(root, "node_modules/pdfjs-dist/build/pdf.mjs"),
            ),
          ],
          "/pdf.worker.min.mjs": [
            "text/javascript",
            fs.readFileSync(
              path.join(
                root,
                "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
              ),
            ),
          ],
          ...(photoPdf ? { "/photo.pdf": ["application/pdf", photoPdf] } : {}),
          ...(cameraPhoto
            ? { "/camera.jpg": ["image/jpeg", cameraPhoto] }
            : {}),
          "/forensicAnalysis.worker.ts": ["text/javascript", worker],
          "/pixels.bin": ["application/octet-stream", Buffer.from(pixels.data)],
          "/mixture.bin": ["application/octet-stream", Buffer.from(mixed.data)],
        }
        const resource = resources[req.url]
        res.writeHead(resource ? 200 : 404, {
          "content-type": resource?.[0] || "text/plain",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'",
        })
        res.end(resource?.[1] || "not found")
      },
    )
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `https://127.0.0.1:${server.address().port}`
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
    )
    send = createChromeProtocolPipe(browser, (message) => {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(message.id)
      message.error
        ? request.reject(new Error(message.error.message))
        : request.resolve(message.result)
    })
    const { targetId } = await call("Target.createTarget", {
      url: "about:blank",
    })
    const attached = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    })
    session = attached.sessionId
    await call("Page.enable")
    await call("Page.navigate", { url: origin })
    const result = await call("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{
        const BaseWorker=globalThis.Worker;let liveWorker;
        globalThis.Worker=class extends BaseWorker{constructor(...args){super(...args);liveWorker=this;this.addEventListener('error',e=>{globalThis.fixtureWorkerError={message:e.message,filename:e.filename,line:e.lineno}})}};
        const {createForensicAnalyzer}=await import(${JSON.stringify(origin + "/analyzer.mjs")});
        const makeCandidates=()=>[{markId:${JSON.stringify(markId)},pattern:new Float32Array(${JSON.stringify([...pattern])})}];
        const candidates=makeCandidates();
        const controller=new AbortController();
        const analyzer=await createForensicAnalyzer(candidates,controller.signal);
        const pixels={width:1920,height:1440,data:new Uint8ClampedArray(await (await fetch('/pixels.bin')).arrayBuffer())};
        const pending=analyzer.analyse(pixels);
        liveWorker.dispatchEvent(new MessageEvent('message',{data:{id:2,type:'result',result:{
          status:'match',rotation:0,topScore:999,runnerUpScore:0,scales:[1],
          compatible:[{markId:candidates[0].markId,score:999,scale:1,falseMatchLog10:-100}],
          best:{markId:candidates[0].markId,score:999,scale:1,falseMatchLog10:-100}}}}));
        const match=await pending;
        const patternTransferred=candidates[0].pattern.byteLength===0;
        analyzer.close();
        const mixedCandidates=[...makeCandidates(),{markId:${JSON.stringify(otherId)},pattern:new Float32Array(${JSON.stringify([...otherPattern])})}];
        const mixedAnalyzer=await createForensicAnalyzer(mixedCandidates,new AbortController().signal);
        const mixed=await mixedAnalyzer.analyse({width:512,height:512,data:new Uint8ClampedArray(await (await fetch('/mixture.bin')).arrayBuffer())});
        mixedAnalyzer.close();
        const abort=new AbortController();
        const stopped=await createForensicAnalyzer(makeCandidates(),abort.signal);
        const waiting=stopped.analyse({width:1920,height:1440,data:new Uint8ClampedArray(1920*1440*4).fill(255)});
        abort.abort();
        let aborted=false;try{await waiting}catch(e){aborted=e.name==='AbortError'}
        return {status:match.status,id:match.best?.markId,aborted,syntheticIgnored:match.best?.score!==999,
          patternTransferred,ambiguous:mixed.status==='ambiguous_multiple_sources'&&mixed.best===null&&mixed.compatible.length===2};
      })()`,
    })
    if (result.exceptionDetails) {
      const diagnostic = await call("Runtime.evaluate", {
        expression: "globalThis.fixtureWorkerError",
        returnByValue: true,
      })
      assert.fail(
        JSON.stringify({
          exception: result.exceptionDetails,
          worker: diagnostic.result.value,
        }),
      )
    }
    assert.deepEqual(result.result.value, {
      status: "match",
      id: markId,
      aborted: true,
      syntheticIgnored: true,
      patternTransferred: true,
      ambiguous: true,
    })
    console.log(
      "real Chrome production worker: match, trusted message flow and in-flight cancellation passed",
    )
    const visible = await call("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{
        const {appendCopyMarker,visibleCopyToken,detectVisibleCopyMarks}=await import('/visibleCopyMark.util');
        const {createForensicAnalyzer}=await import('/analyzer.mjs');
        const {forensicDecision}=await import('/decision.mjs');
        const markId='1'.repeat(32);
        const token=await visibleCopyToken(new Uint8Array(32).fill(17),markId);
        const original=document.createElement('canvas');original.width=600;original.height=900;
        const context=original.getContext('2d');context.fillStyle='white';context.fillRect(0,0,600,900);
        context.fillStyle='black';context.font='20px sans-serif';context.fillText('Local copy-marker control',40,100);
        const before=context.getImageData(0,0,600,900);
        const marked=appendCopyMarker(original,token);
        const preserved=marked.context.getImageData(0,0,600,900);
        const contentPreserved=before.data.every((v,i)=>v===preserved.data[i]);
        const encoded=await new Promise(resolve=>marked.canvas.toBlob(resolve,'image/png'));
        const bitmap=await createImageBitmap(encoded);
        marked.context.clearRect(0,0,marked.canvas.width,marked.canvas.height);
        marked.context.drawImage(bitmap,0,0);bitmap.close();
        const local=detectVisibleCopyMarks(marked.context.getImageData(0,0,marked.canvas.width,marked.canvas.height),[{markId,visibleToken:token,pattern:new Float32Array(128*128)}]);
        const analyzer=await createForensicAnalyzer([{markId,pattern:new Float32Array(${JSON.stringify([...pattern])}),visibleToken:token}],new AbortController().signal);
        try{
          const analysis=await analyzer.analyse(marked.context.getImageData(0,0,marked.canvas.width,marked.canvas.height));
          return {decision:forensicDecision([{analysis}]),contentPreserved,png:encoded.type==='image/png',local,visible:analysis.visibleMarkIds};
        }finally{analyzer.close()}
      })()`,
    })
    assert.ok(
      !visible.exceptionDetails,
      JSON.stringify(visible.exceptionDetails),
    )
    assert.deepEqual(visible.result.value, {
      decision: { kind: "visible_marker", markId },
      contentPreserved: true,
      png: true,
      local: [markId],
      visible: [markId],
    })
    console.log(
      "real Chrome production worker: lossless visible marker, preserved document pixels and separate verdict passed",
    )
    if (cameraPhoto) {
      const cases = []
      for (const width of cameraCondition === "coarse"
        ? [null, 2000, 320]
        : [null]) {
        for (const [name, available] of [
          ["expected", cameraCandidates],
          ["without-expected", cameraCandidates.slice(1)],
          ["wrong-team", wrongCameraCandidates],
        ]) {
          const started = performance.now()
          const camera = await call("Runtime.evaluate", {
            awaitPromise: true,
            returnByValue: true,
            expression: `(async()=>{
              const {createForensicAnalyzer}=await import('/analyzer.mjs');
              const {suspectImages}=await import('/suspect.mjs');
              const {forensicDecision}=await import('/decision.mjs');
              const bytes=await(await fetch('/camera.jpg')).arrayBuffer();
              let blob=new Blob([bytes],{type:'image/jpeg'});
              const width=${JSON.stringify(width)};
              if(width!==null){
                const bitmap=await createImageBitmap(blob);
                try{
                  const canvas=new OffscreenCanvas(width,Math.round(bitmap.height*width/bitmap.width));
                  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
                  blob=await canvas.convertToBlob({type:'image/png'});
                }finally{bitmap.close()}
              }
              const available=${JSON.stringify(available)};
              const controller=new AbortController();
              const analyzer=await createForensicAnalyzer(available.map(c=>({...c,pattern:new Float32Array(c.pattern)})),controller.signal);
              const results=[];
              try{for await(const image of suspectImages(new File([blob],'camera',{type:blob.type}),controller.signal)){
                results.push({analysis:await analyzer.analyse(image.pixels)});
              }}finally{analyzer.close()}
              return {decision:forensicDecision(results),topScore:results[0].analysis.topScore,runnerUpScore:results[0].analysis.runnerUpScore};
            })()`,
          })
          assert.ok(
            !camera.exceptionDetails,
            JSON.stringify(camera.exceptionDetails),
          )
          cases.push({
            name,
            width,
            ...camera.result.value,
            elapsedMs: Math.round(performance.now() - started),
          })
          console.log(
            "camera control",
            width ?? "original",
            name,
            camera.result.value.decision.kind,
          )
        }
      }
      assert.equal(cases.length, cameraCondition === "coarse" ? 9 : 3)
      for (let index = 0; index < cases.length; index += 3) {
        assert.equal(
          cases[index].decision.kind,
          cameraCondition === "coarse" ? "match" : "visible_marker",
          JSON.stringify(cases),
        )
        assert.equal(
          cases[index].decision.detection?.markId ??
            cases[index].decision.markId,
          cameraCandidates[0].markId,
        )
        assert.equal(
          cases[index + 1].decision.kind,
          "none",
          JSON.stringify(cases),
        )
        assert.equal(
          cases[index + 2].decision.kind,
          "none",
          JSON.stringify(cases),
        )
      }
      console.log(
        "real smartphone photo, production worker and image-file path:",
        JSON.stringify(cases),
      )
    }
    if (photoPdf) {
      const evaluated = await call("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async()=>{
          const {createForensicAnalyzer}=await import('/analyzer.mjs');
          const {suspectImages}=await import('/suspect.mjs');
          const {forensicDecision}=await import('/decision.mjs');
          const candidates=${JSON.stringify(photoCandidates)}.map(c=>({...c,pattern:new Float32Array(c.pattern)}));
          const controller=new AbortController();
          const analyzer=await createForensicAnalyzer(candidates,controller.signal);
          const file=new File([await(await fetch('/photo.pdf')).arrayBuffer()],'registered.pdf',{type:'application/pdf'});
          const results=[];
          try{for await(const image of suspectImages(file,controller.signal)){
            results.push({page:image.page,source:image.source,width:image.pixels.width,height:image.pixels.height,analysis:await analyzer.analyse(image.pixels)});
          }}finally{analyzer.close()}
          return {decision:forensicDecision(results),images:results.length,pages:[...new Set(results.map(r=>r.page))],diagnostics:results.map(r=>({page:r.page,source:r.source,width:r.width,height:r.height,status:r.analysis.status,score:r.analysis.topScore}))};
        })()`,
      })
      assert.ok(
        !evaluated.exceptionDetails,
        JSON.stringify(evaluated.exceptionDetails),
      )
      const value = evaluated.result.value
      assert.equal(value.decision.kind, "match", JSON.stringify(value))
      assert.equal(value.decision.detection.markId, photoCandidates[0].markId)
      assert.deepEqual(value.pages, [1, 2])
      assert.ok(
        value.images >= 4,
        "Both embedded rasters and rendered pages must contribute",
      )
      console.log(
        `PDF ${photoCondition ? "real photo " + photoCondition : "synthetic control"}: PDF.js, ${value.images} images, all pages and production worker passed, score ${value.decision.detection.score.toFixed(2)}`,
      )
    }
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("test closed"))
    }
    browser?.kill()
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
