const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const https = require("node:https")
const { spawn, execFileSync } = require("node:child_process")
const { createCipheriv, createHash, randomBytes, X509Certificate } = require("node:crypto")
const { webpack } = require("next/dist/compiled/webpack/webpack")
const sharp = require("sharp")
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs")

async function main() {
  const root = path.resolve(__dirname, "..")
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pc-external-viewer-"))
  fs.chmodSync(temporary, 0o700)
  let browser, server, session, sequence = 0
  const pending = new Map()
  try {
    const mocks = path.join(temporary, "mocks.js")
    fs.writeFileSync(mocks, `
      globalThis.pageStats={active:0,maximum:0,requests:[],aborted:0}
      export default {
        getContractorPage:async(_preview,index,signal)=>{
          const stats=globalThis.pageStats
          stats.active++;stats.maximum=Math.max(stats.maximum,stats.active);stats.requests.push(index)
          try {
            const reply=await fetch('/pages/'+index,{signal})
            if(!reply.ok)throw new Error('Synthetic transfer failure')
            return new Uint8Array(await reply.arrayBuffer())
          } catch(error) {if(signal.aborted)stats.aborted++;throw error}
          finally {stats.active--}
        }
      }
    `)
    const translate = path.join(temporary, "translate.js")
    fs.writeFileSync(translate, "export default ()=>key=>key")
    const cryptoMock = path.join(temporary, "crypto.js")
    fs.writeFileSync(cryptoMock, "const unused=()=>{throw new Error('Unused wrapping fixture')};export {unused as decryptPrivateKey,unused as getMyIdentityKeys,unused as getMyPQKey,unused as hybridUnwrapDEK,unused as hybridWrapDEK}")
    await new Promise((resolve, reject) => {
      const compiler = webpack({
        mode: "development", devtool: false, context: root,
        entry: path.join(__dirname, "fixtures/external-viewer.tsx"),
        output: { path: temporary, filename: "viewer.js" },
        resolve: { extensions: [".tsx", ".ts", ".js", ".mjs"], modules: [path.join(root, "node_modules"), "node_modules"], fallback: { path: false } },
        module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(__dirname, "browser-typescript-loader.cjs") }] },
        plugins: [new webpack.NormalModuleReplacementPlugin(/teamExternal\.service$/, mocks), new webpack.NormalModuleReplacementPlugin(/useTranslate\.hook$/, translate), new webpack.NormalModuleReplacementPlugin(/crypto\.service$/, cryptoMock)],
      })
      compiler.run((error, stats) => compiler.close(() => {
        if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      }))
    })
    const assets = new Map([
      ["/", ["text/html", Buffer.from('<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/viewer.js"></script>')]],
      ["/viewer.js", ["text/javascript", fs.readFileSync(path.join(temporary, "viewer.js"))]],
      ["/style.css", ["text/css", fs.readFileSync(path.join(root, "node_modules/@mantine/core/styles.css"))]],
    ])
    const syntheticKey = randomBytes(32)
    assets.set("/fixture-key", ["application/octet-stream", syntheticKey])
    for (let index = 0; index < 30; index++) {
      const png = await sharp({ create: { width: 512, height: 640, channels: 4, background: { r: 70 + index, g: 120, b: 180, alpha: 1 } } }).png().toBuffer()
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", syntheticKey, iv)
      cipher.setAAD(Buffer.from(`privcloud-external-page:v1:synthetic-viewer:${index}`))
      assets.set("/pages/" + index, ["application/octet-stream", Buffer.concat([iv, cipher.update(png), cipher.final(), cipher.getAuthTag()])])
    }
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(temporary, "key.pem"), "-out", path.join(temporary, "cert.pem")], { stdio: "ignore" })
    const cert = fs.readFileSync(path.join(temporary, "cert.pem"))
    const pin = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64")
    let failFirst = true
    const sendAsset = (route, asset, response) => {
      const reply = () => {
        const failed = route === "/pages/0" && failFirst
        if (failed) failFirst = false
        response.writeHead(failed ? 503 : 200, {
          "content-type": asset[0], "cache-control": "no-store", "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'nonce-viewer-fixture'; img-src 'self' data:; font-src 'self'",
        })
        response.end(failed ? "Synthetic failure" : asset[1])
      }
      if (route.startsWith("/pages/")) {
        const timer = setTimeout(reply, 150)
        response.on("close", () => clearTimeout(timer))
      } else reply()
    }
    server = https.createServer({ key: fs.readFileSync(path.join(temporary, "key.pem")), cert }, (request, response) => {
      const route = new URL(request.url || "/", "https://127.0.0.1").pathname
      const asset = assets.get(route)
      if (asset) sendAsset(route, asset, response)
      else { response.writeHead(404, { "content-type": "text/plain", "x-content-type-options": "nosniff" }); response.end("not found") }
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    browser = spawn("/usr/bin/google-chrome", ["--headless=new", "--no-first-run", "--no-proxy-server", "--disable-background-networking", "--remote-debugging-pipe", "--ignore-certificate-errors-spki-list=" + pin, "--user-data-dir=" + path.join(temporary, "profile"), "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] })
    const send = createChromeProtocolPipe(browser, message => {
      const item = pending.get(message.id)
      if (!item) return
      clearTimeout(item.timer)
      pending.delete(message.id)
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result)
    }, error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) } pending.clear() })
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")) }, 30_000)
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params, ...(session ? { sessionId: session } : {}) })
    })
    const evaluate = async expression => {
      const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }
    const wait = condition => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+15000;const check=()=>{if(${condition})resolve();else if(Date.now()>end)reject(new Error('Viewer condition timeout'));else setTimeout(check,25)};check()})`)
    const target = await call("Target.createTarget", { url: "about:blank" })
    session = (await call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId
    await call("Page.enable")
    await call("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
    await call("Page.navigate", { url: "https://127.0.0.1:" + server.address().port })
    await wait("globalThis.viewerReady && document.querySelector('button')")
    assert.ok((await evaluate("initialCanvases")).every(([w, h]) => w === 1 && h === 1))
    await evaluate("document.querySelector('button').click()")
    await wait("document.querySelector('canvas').width===512")
    const firstVisibleMs = await evaluate("Math.round(performance.now())")
    await evaluate("globalThis.scrollStart=performance.now();document.querySelectorAll('canvas')[24].scrollIntoView()")
    await wait("document.querySelectorAll('canvas')[24].width===512")
    await wait("document.querySelector('canvas').width===1")
    const result = await evaluate(`({firstVisibleMs:${firstVisibleMs},jumpToPage25Ms:Math.round(performance.now()-scrollStart),stats:pageStats,painted:[...document.querySelectorAll('canvas')].filter(c=>c.width===512).length,pixel:[...document.querySelectorAll('canvas')[24].getContext('2d').getImageData(0,0,1,1).data],violations})`)
    assert.ok(result.stats.maximum <= 2)
    assert.ok(result.stats.requests.filter(index => index === 0).length >= 2)
    assert.ok(result.painted < 30)
    assert.deepEqual(result.pixel, [94, 120, 180, 255])
    assert.deepEqual(result.violations, [])
    console.log(JSON.stringify(result))
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer)
    pending.clear()
    browser?.kill()
    if (server) await new Promise(resolve => server.close(resolve))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
