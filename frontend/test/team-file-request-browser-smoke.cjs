const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { createHash, X509Certificate } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createChromeProtocolPipe } = require("./chrome-protocol-pipe.cjs");
const root = path.resolve(__dirname, "..");
const locale = process.env.FILE_REQUEST_TEST_LOCALE || "fr-FR";
assert.ok(["fr-FR", "en-US"].includes(locale));
const ts = require(path.join(root, "node_modules/typescript"));
const translated = ts.transpileModule(
  fs.readFileSync(
    path.join(root, `src/i18n/translations/${locale}.ts`),
    "utf8",
  ),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const catalogueModule = { exports: {} };
new Function("exports", "module", translated)(
  catalogueModule.exports,
  catalogueModule,
);
const labels = catalogueModule.exports.default;
const t = (key) => labels["team.fileRequest." + key];
const webpack = require(
  path.join(root, "node_modules/next/dist/compiled/webpack/webpack"),
).webpack;
const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "privcloud-file-request-ui-"),
);
const write = (name, content) => {
  const file = path.join(fixture, name);
  fs.writeFileSync(file, content);
  return file;
};
let server, browser;
(async () => {
  try {
    const teamA = "123e4567-e89b-42d3-a456-426614174000";
    const teamB = "123e4567-e89b-42d3-a456-426614174001";
    const creator = "123e4567-e89b-42d3-a456-426614174002";
    const bob = "123e4567-e89b-42d3-a456-426614174003";
    const alice = "123e4567-e89b-42d3-a456-426614174004";
    const data = write(
      "data.js",
      `
export const ids = ${JSON.stringify({ teamA, teamB, creator, bob, alice })};
export const users = [
 { id: ids.creator, username: "Demandeur", email: "creator@example.test" },
 { id: ids.bob, username: "Bob", email: "bob@example.test" },
 { id: ids.alice, username: "Alice", email: "alice@example.test" },
];
export const teams = [{id:ids.teamA,name:"Équipe A"},{id:ids.teamB,name:"Équipe B"}];
export const members = users.map((user,index) => ({id:"member-"+index,user, userId:user.id, isActive:true, keyStatus:"CURRENT", role:index ? "MEMBER" : "OWNER", pushNotifMode:"EVERY_FILE"}));
export const folderOptions = teamId => teamId === ids.teamA
 ? [{id:"a-folder",name:"A-only",parentId:null,recipients:users.slice(1).map(u=>({...u,canUpload:true}))}]
 : [{id:"b-root",name:"Documents",parentId:null,recipients:users.slice(1).map(u=>({...u,canUpload:true}))},
    {id:"b-child",name:"Factures",parentId:"b-root",recipients:users.slice(1).map(u=>({...u,canUpload:true}))},
    {id:"b-private",name:"Privé",parentId:null,recipients:users.slice(1).map(u=>({...u,canUpload:u.id===ids.bob}))}];
`,
    );
    const api = write(
      "api.js",
      `
import {ids,users,folderOptions} from ${JSON.stringify(data)};
export default {
 get:async url => {if(url.endsWith("/options")) return {data:folderOptions(url.split("/")[1])};
 return {data:{total:1,requests:[{id:"request-fixture",teamId:ids.teamB,folderId:"b-child",subject:"Demande reçue",note:"Note de test",creatorId:ids.bob,creator:users[1],folder:{id:"b-child",name:"Factures"},expiresAt:new Date(Date.now()+86400000).toISOString(),status:"OPEN",canWrite:true,canRespond:true,recipients:[{user:users[0],fileCount:0}]}]}};},
 post:async (url,payload) => {if(url==="crypto/identity/keys/batch") return {data:payload.userIds.map(userId=>({userId,x25519:{publicKey:window.fixtureKeys[userId].publicKey},pqKey:null}))};
 window.submissions.push(payload);return {data:{id:payload.id}};},
 patch:async () => ({data:{closed:true}})
};`,
    );
    const teams = write(
      "teams.js",
      `import { teams,members } from ${JSON.stringify(data)}; export default {getMyTeams:async()=>teams,getTeam:async id=>({...teams.find(t=>t.id===id),description:"Team fixture",members,pqNotificationEncryptionEnabled:false,sharedFolders:[]}),getTeamKey:async()=>({wrappedTeamKey:"fixture-wrapped-key"}),getKeyRotationStatus:async()=>({policy:{currentVersion:1,reminderActive:false},activeRotation:null}),getMetrics:async()=>({team:{membersCount:1,maxMembers:3,foldersCount:2},storage:{used:10000000000,folderUsed:2000000000,limit:500000000000,percentage:2},activity:{downloads:0,uploads:0,totalFiles:0}}),getFolders:async()=>[],getAuditReports:async()=>[]};`,
    );
    const router = write(
      "router.js",
      `import React from "react";const listeners=new Set();window.setFixtureQuery=query=>{window.fixtureQuery=query;for(const update of listeners)update(n=>n+1);};export const useRouter=()=>{const [,update]=React.useState(0);React.useEffect(()=>{listeners.add(update);return ()=>listeners.delete(update);},[]);return {query:window.fixtureQuery||{},pathname:"/team/[id]",asPath:"/team/fixture",isReady:true,push:async url=>{window.navigations.push(url);return true;},replace:async target=>{if(target&&typeof target==="object")window.setFixtureQuery(target.query);return true;}};};`,
    );
    const toast = write(
      "toast.js",
      `export default {success:message=>window.toasts.push(message),error:message=>window.toasts.push(message)};`,
    );
    const user = write(
      "user.js",
      `import { users } from ${JSON.stringify(data)}; export default ()=>({user:users[0],hasTeamMembership:true});`,
    );
    const entry = write(
      "entry.tsx",
      `
import React from "react";
import {createRoot} from "react-dom/client";
import {IntlProvider} from "react-intl";
import messages from ${JSON.stringify(path.join(root, `src/i18n/translations/${locale}.ts`))};
import {MantineProvider} from "@mantine/core";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import TeamFileRequests from ${JSON.stringify(path.join(root, "src/components/team/TeamFileRequests.tsx"))};
import TeamDashboardMetrics from ${JSON.stringify(path.join(root, "src/components/team/TeamDashboardMetrics.tsx"))};
import TeamEncryptionStatus from ${JSON.stringify(path.join(root, "src/components/team/TeamEncryptionStatus.tsx"))};
import TeamDashboard from ${JSON.stringify(path.join(root, "src/pages/team/[id]/index.tsx"))};
import TeamSettings from ${JSON.stringify(path.join(root, "src/pages/team/[id]/settings.tsx"))};
import {ids,users} from ${JSON.stringify(data)};
import {generateX25519KeyPair,unwrapDEKFromGrant} from ${JSON.stringify(path.join(root, "src/services/crypto.service.ts"))};
window.submissions=[];window.navigations=[];window.toasts=[];window.fixtureKeys={};
window.decryptEnvelope=async (userId,envelopeText)=>{const envelope=JSON.parse(envelopeText);const plaintext=await unwrapDEKFromGrant({encryptedFileKey:envelope.ciphertext,ephemeralPublicKey:envelope.ephemeralPublicKey,nonce:envelope.nonce},window.fixtureKeys[userId].privateKey);return JSON.parse(new TextDecoder().decode(plaintext));};
(async()=>{for(const u of users){const pair=await generateX25519KeyPair();window.fixtureKeys[u.id]={...pair,publicKey:btoa(String.fromCharCode(...pair.publicKey)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")};}
const root=createRoot(document.getElementById("root"));window.showSettings=()=>{window.setFixtureQuery({id:ids.teamB});root.render(<IntlProvider locale=${JSON.stringify(locale)} messages={messages}><MantineProvider forceColorScheme="dark"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><div style={{padding:16,maxWidth:1000,margin:"auto"}}><TeamSettings/></div></QueryClientProvider></MantineProvider></IntlProvider>);};window.showDashboard=()=>{window.setFixtureQuery({id:ids.teamB});root.render(<IntlProvider locale=${JSON.stringify(locale)} messages={messages}><MantineProvider forceColorScheme="dark"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><div style={{padding:16,maxWidth:1000,margin:"auto"}}><TeamDashboard/></div></QueryClientProvider></MantineProvider></IntlProvider>);};root.render(<IntlProvider locale=${JSON.stringify(locale)} messages={messages}><MantineProvider forceColorScheme="dark"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><div style={{padding:24,maxWidth:900,margin:"auto"}}><section id="dashboard-fixture"><TeamDashboardMetrics metrics={{team:{membersCount:1,maxMembers:3,foldersCount:2},storage:{used:10000000000,folderUsed:2000000000,limit:500000000000,percentage:2},activity:{downloads:0,uploads:0,totalFiles:0}}}/><TeamEncryptionStatus canRotate={true} onRotate={()=>{window.rotationClicks=(window.rotationClicks||0)+1;}}/></section><TeamFileRequests/><TeamFileRequests teamId={ids.teamB}/></div></QueryClientProvider></MantineProvider></IntlProvider>);})();
`,
    );
    const loader = write(
      "loader.cjs",
      `const ts=require(${JSON.stringify(path.join(root, "node_modules/typescript"))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},fileName:this.resourcePath}).outputText};`,
    );
    const cssLoader = write(
      "css-loader.cjs",
      `module.exports=function(source){const names=[...source.matchAll(/\\.([a-zA-Z][a-zA-Z0-9]*)/g)].map(m=>m[1]);return "const style=document.createElement('style');style.textContent="+JSON.stringify(source)+";document.head.appendChild(style);export default "+JSON.stringify(Object.fromEntries(names.map(n=>[n,n])));}`,
    );
    await new Promise((resolve, reject) =>
      webpack(
        {
          mode: "development",
          devtool: false,
          entry,
          output: { path: fixture, filename: "bundle.js" },
          plugins: [
            new webpack.DefinePlugin({
              "process.env": JSON.stringify({
                NEXT_PUBLIC_TEAM_MAX_FOLDERS: "10",
              }),
            }),
            new webpack.NormalModuleReplacementPlugin(
              /(?:^|\/)(api\.service|team\.service|user\.hook|toast\.util)(?:\.tsx?)?$/,
              (resource) => {
                const name = resource.request
                  .split("/")
                  .at(-1)
                  .replace(/\.tsx?$/, "");
                resource.request = {
                  "api.service": api,
                  "team.service": teams,
                  "user.hook": user,
                  "toast.util": toast,
                }[name];
              },
            ),
          ],
          resolve: {
            fallback: {
              path: path.join(
                root,
                "node_modules/next/dist/compiled/path-browserify",
              ),
            },
            extensions: [".ts", ".tsx", ".js"],
            modules: [path.join(root, "node_modules"), "node_modules"],
            alias: {
              [path.join(root, "src/services/api.service.ts")]: api,
              [path.join(root, "src/services/team.service.ts")]: teams,
              [path.join(root, "src/hooks/user.hook.ts")]: user,
              [path.join(root, "src/utils/toast.util.tsx")]: toast,
              "next/router$": router,
            },
          },
          module: {
            rules: [
              { test: /\.css$/, use: cssLoader },
              { test: /\.[tj]sx?$/, exclude: /node_modules/, use: loader },
            ],
          },
        },
        (error, stats) => {
          if (error || stats.hasErrors())
            reject(
              error || new Error(stats.toString({ all: false, errors: true })),
            );
          else resolve();
        },
      ),
    );
    const keyPath = path.join(fixture, "key.pem");
    const certPath = path.join(fixture, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore", timeout: 15000 },
    );
    const cert = fs.readFileSync(certPath);
    const certificatePin = createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64");
    server = https.createServer(
      { key: fs.readFileSync(keyPath), cert, minVersion: "TLSv1.2" },
      (req, res) => {
        if (req.url === "/bundle.js") {
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
          res.end(fs.readFileSync(path.join(fixture, "bundle.js")));
        } else if (req.url === "/style.css") {
          res.setHeader("Content-Type", "text/css");
          res.end(
            fs.readFileSync(
              path.join(root, "node_modules/@mantine/core/styles.css"),
            ),
          );
        } else {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
          );
        }
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const profile = path.join(fixture, "chrome");
    browser = spawn(
      process.env.CHROME_BIN || "/opt/google/chrome/google-chrome",
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-background-networking",
        // Trust only the temporary fixture key in this isolated browser profile.
        `--ignore-certificate-errors-spki-list=${certificatePin}`,
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
    let seq = 0;
    const pending = new Map();
    const errors = [];
    const send = createChromeProtocolPipe(browser, (m) => {
      if (m.method === "Runtime.exceptionThrown")
        errors.push(
          m.params.exceptionDetails.exception?.description ||
            m.params.exceptionDetails.text,
        );
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    const call = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(
          () => reject(new Error("CDP timeout: " + method)),
          15000,
        );
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
    await call("Runtime.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);
    await call(
      "Page.navigate",
      { url: `https://127.0.0.1:${server.address().port}` },
      sessionId,
    );
    const evaluate = async (expression) => {
      const r = await call(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (r.exceptionDetails)
        throw new Error(
          r.exceptionDetails.exception?.description || r.exceptionDetails.text,
        );
      return r.result.value;
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`!!document.body && (${expression})`)) return;
        await new Promise((r) => setTimeout(r, 75));
      }
      throw new Error(
        "UI wait timed out: " +
          expression +
          " errors=" +
          JSON.stringify(errors) +
          " body=" +
          (await evaluate("document.body?.textContent?.slice(0,3000)")),
      );
    };
    const click = async (text) =>
      evaluate(
        `(()=>{const n=[...document.querySelectorAll('button,label,[role="option"]')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw new Error('Missing control: '+${JSON.stringify(text)});n.click();return true;})()`,
      );
    const input = async (label, value) =>
      evaluate(
        `(()=>{const l=[...document.querySelectorAll('label')].find(n=>n.textContent.startsWith(${JSON.stringify(label)}));const e=document.getElementById(l.htmlFor);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
      );
    const select = async (label, option) => {
      await waitFor(
        `(()=>{const l=[...document.querySelectorAll("label")].find(n=>n.textContent.startsWith(${JSON.stringify(label)}));return l && document.getElementById(l.htmlFor) && !document.getElementById(l.htmlFor).disabled;})()`,
      );
      await evaluate(
        `(()=>{const l=[...document.querySelectorAll('label')].find(n=>n.textContent.startsWith(${JSON.stringify(label)}));document.getElementById(l.htmlFor).click();})()`,
      );
      await waitFor(
        `[...document.querySelectorAll('[role="option"]')].some(n=>n.textContent.trim()===${JSON.stringify(option)})`,
      );
      await click(option);
    };
    await waitFor(`document.body.textContent.includes('Demande reçue')`);
    for (const width of [320, 390, 680, 980]) {
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 900, deviceScaleFactor: 1, mobile: width <= 680 },
        sessionId,
      );
      await evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      const layout = await evaluate(`(()=>{
        const bounds=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,height:r.height};};
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,metrics:bounds(document.querySelector('[data-team-metrics]')),values:bounds(document.querySelector('[data-storage-values]')),gauge:bounds(document.querySelector('[data-storage-gauge]')),banner:bounds(document.querySelector('#dashboard-fixture [role="alert"]')),cards:[...document.querySelector('[data-team-metrics]').children].map(bounds)};
      })()`);
      assert.equal(
        layout.overflow,
        false,
        `No horizontal overflow at ${width}px`,
      );
      assert.ok(
        width > 680 || layout.gauge.left >= layout.values.right - 1,
        `Storage gauge is right of values at ${width}px`,
      );
      const gauge = await evaluate(
        `(()=>{const parent=document.querySelector('[data-storage-gauge]');const circle=parent.querySelector('svg').getBoundingClientRect();const label=parent.querySelector('p').getBoundingClientRect();return {x:Math.abs(label.x+label.width/2-circle.x-circle.width/2),y:Math.abs(label.y+label.height/2-circle.y-circle.height/2),size:circle.width,text:parent.textContent.trim()};})()`,
      );
      assert.ok(
        gauge.x < 1 && gauge.y < 1,
        `Percentage is centered at ${width}px`,
      );
      assert.equal(gauge.text, "2%");
      assert.equal(gauge.size, width <= 680 ? 56 : 76);
      if (width > 680) {
        const amounts = await evaluate(
          `(()=>{const gauge=document.querySelector('[data-storage-gauge]').getBoundingClientRect();return [...document.querySelectorAll('[data-storage-amount]')].map(n=>{const r=n.getBoundingClientRect();const parent=n.parentElement.getBoundingClientRect();return {gap:r.top-gauge.bottom,left:r.left-parent.left,width:r.width,parentWidth:parent.width};});})()`,
        );
        assert.equal(amounts.length, 2);
        assert.ok(
          amounts.every((row) => row.gap >= 4),
          "Storage amounts remain below the gauge",
        );
        assert.ok(
          amounts.every(
            (row) => row.left === 0 && row.width === row.parentWidth,
          ),
          "Storage amounts keep the original full-width placement",
        );
      }
      if (width <= 680) {
        assert.ok(
          layout.metrics.height <= 220,
          `Compact metrics at ${width}px: ${layout.metrics.height}`,
        );
        assert.ok(
          layout.banner.height <= 95,
          `Compact encryption at ${width}px: ${layout.banner.height}`,
        );
        assert.equal(layout.cards[1].top, layout.cards[2].top);
        assert.equal(layout.cards[2].top, layout.cards[3].top);
        assert.ok(layout.cards[0].top < layout.cards[1].top);
      } else {
        assert.ok(
          layout.cards.every((card) => card.top === layout.cards[0].top),
        );
      }
    }
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 900, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    await evaluate("new Promise(r=>requestAnimationFrame(r))");
    await evaluate(
      "document.querySelector('#dashboard-fixture button').click()",
    );
    assert.equal(await evaluate("window.rotationClicks"), 1);
    await evaluate(
      "document.querySelector('#dashboard-fixture summary').click()",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#dashboard-fixture details').open",
      ),
      true,
    );
    await evaluate(
      "document.querySelector('#dashboard-fixture summary').click()",
    );
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width: 980, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await click(t("upload"));
    assert.ok(
      (await evaluate("window.navigations.at(-1)")).includes(
        "teamFileRequestId=request-fixture",
      ),
    );
    await click(t("create"));
    await select(t("team"), "Équipe A");
    await select(t("destination"), "A-only");
    await select(t("recipients"), "Bob (bob@example.test)");
    await select(t("team"), "Équipe B");
    await waitFor(
      `[...document.querySelectorAll('input')].some(n=>n.getAttribute('aria-haspopup')==='listbox' && n.value==='')`,
    );
    await select(t("destination"), "Documents / Factures");
    await input(t("subject"), "Documents du mois");
    await click(t("scope.all"));
    await click(t("email"));
    await click(t("submit"));
    await waitFor("window.submissions.length===1");
    const first = await evaluate("window.submissions[0]");
    assert.equal(first.recipientScope, "ALL");
    assert.equal(first.sendEmail, true);
    assert.equal(first.recipientIds.length, 2);
    assert.equal(first.notifications.length, 2);
    assert.ok(
      !first.notifications.some((n) =>
        n.encryptedMetadata.includes("Documents du mois"),
      ),
    );
    for (const n of first.notifications) {
      const meta = await evaluate(
        `window.decryptEnvelope(${JSON.stringify(n.userId)},${JSON.stringify(n.encryptedMetadata)})`,
      );
      assert.equal(meta.subject, "Documents du mois");
      assert.equal(meta.action, "FILE_REQUEST");
    }
    const confirmation = await evaluate(
      `window.decryptEnvelope(${JSON.stringify(creator)},${JSON.stringify(first.submissionNotification)})`,
    );
    assert.equal(confirmation.action, "FILE_REQUEST_SUBMITTED");
    await waitFor("!document.querySelector('[role=dialog]')");
    await click(t("create"));
    await select(t("team"), "Équipe B");
    await select(t("destination"), "Documents / Factures");
    await input(t("subject"), "Pour Bob uniquement");
    await click(t("scope.selected"));
    await select(t("recipients"), "Bob (bob@example.test)");
    await click(t("submit"));
    await waitFor("window.submissions.length===2");
    const second = await evaluate("window.submissions[1]");
    assert.equal(second.recipientScope, "SELECTED");
    assert.deepEqual(second.recipientIds, [bob]);
    assert.equal(second.sendEmail, false);
    assert.equal(second.notifications.length, 1);
    await waitFor("!document.querySelector('[role=dialog]')");
    await click(t("create"));
    await select(t("team"), "Équipe B");
    await select(t("destination"), "Privé");
    await click(t("scope.all"));
    await waitFor(
      `document.body.textContent.includes(${JSON.stringify(t("allRights"))})`,
    );
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('button')).find(n=>n.textContent===${JSON.stringify(t("submit"))}).disabled`,
      ),
      true,
    );
    await evaluate("window.showDashboard()");
    await waitFor(
      "!!document.querySelector('[role=tablist]') && !!document.querySelector('[data-team-metrics]') && !!document.querySelector('details')",
    );
    for (const width of [320, 390, 680, 980]) {
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 900, deviceScaleFactor: 1, mobile: width <= 680 },
        sessionId,
      );
      await evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      const position = await evaluate(
        `(()=>{const tabs=document.querySelector('[role=tablist]');const r=tabs.getBoundingClientRect();return {top:r.top,height:r.height,overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      if (process.env.FILE_REQUEST_TEST_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.FILE_REQUEST_TEST_SCREENSHOT_DIR, {
          recursive: true,
        });
        const screenshot = await call(
          "Page.captureScreenshot",
          { format: "png" },
          sessionId,
        );
        fs.writeFileSync(
          path.join(
            process.env.FILE_REQUEST_TEST_SCREENSHOT_DIR,
            path.basename(path.dirname(root)) +
              "-" +
              locale +
              "-" +
              width +
              ".png",
          ),
          Buffer.from(screenshot.data, "base64"),
        );
      }
      assert.equal(
        position.overflow,
        false,
        `Dashboard has no horizontal overflow at ${width}px`,
      );
      if (width <= 680) {
        assert.ok(
          position.top < 500,
          `Tabs appear above 500px at ${width}px: ${position.top}`,
        );
        assert.ok(position.height < 55, `Tabs stay on one row at ${width}px`);
      }
    }
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 900, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    await evaluate(
      "window.setFixtureQuery({...window.fixtureQuery,fileRequests:'1'})",
    );
    await waitFor(
      `document.querySelector('[role="tab"][data-active]')?.textContent===${JSON.stringify(labels["team.dashboard.tabs.requests"])}`,
    );
    await waitFor(
      `document.body.textContent.includes(${JSON.stringify(t("subject"))})===false && document.body.textContent.includes('Demande reçue')`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('[role="tab"]')).find(n=>n.textContent===${JSON.stringify(labels["team.dashboard.tabs.members"])}).click()`,
    );
    await waitFor("window.fixtureQuery.fileRequests===undefined");
    assert.equal(
      await evaluate(
        "document.querySelector('[role=tab][data-active]').textContent",
      ),
      labels["team.dashboard.tabs.members"],
    );
    await evaluate("window.showSettings()");
    await waitFor(
      `document.querySelector('h2')?.textContent===${JSON.stringify(labels["team.settings.title"])}`,
    );
    for (const width of [320, 390, 980]) {
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 900, deviceScaleFactor: 1, mobile: width <= 680 },
        sessionId,
      );
      await evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      const position = await evaluate(
        `(()=>{const root=document.querySelector('.mantine-Container-root');return {top:root.getBoundingClientRect().top,heading:document.querySelector('h2').getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      assert.equal(
        position.top,
        16,
        `Settings use the common page offset at ${width}px`,
      );
      assert.ok(
        position.heading < 90,
        `Settings heading stays close to the top at ${width}px: ${position.heading}`,
      );
      assert.equal(
        position.overflow,
        false,
        `Settings have no horizontal overflow at ${width}px`,
      );
      if (process.env.FILE_REQUEST_TEST_SCREENSHOT_DIR) {
        const screenshot = await call(
          "Page.captureScreenshot",
          { format: "png" },
          sessionId,
        );
        fs.writeFileSync(
          path.join(
            process.env.FILE_REQUEST_TEST_SCREENSHOT_DIR,
            path.basename(path.dirname(root)) +
              "-settings-" +
              locale +
              "-" +
              width +
              ".png",
          ),
          Buffer.from(screenshot.data, "base64"),
        );
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      locale +
        " Chrome UI passed: team/folder selection and reset, nested folder, mobile metric/encryption layout at 320/390/680px and desktop at 980px, one/all recipients, optional individual email, actual X25519 encrypted-notification round trips, deposit navigation and denied destination, centered percentage and compact settings page",
    );
  } finally {
    if (browser) {
      browser.kill();
      await once(browser, "exit").catch(() => {});
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
