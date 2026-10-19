import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sourceRoot = new URL("../../integrations/gmail-workspace-addon/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("appsscript.json", sourceRoot), "utf8"));
const source = fs.readFileSync(new URL("Code.gs", sourceRoot), "utf8");
const origin = "https://share.example.com";

function addon({ failInsertion = false } = {}) {
  function builder(type) {
    const value = { type };
    const proxy = new Proxy(value, {
      get(target, method) {
        if (method in target) return target[method];
        if (method === "build") return () => target;
        if (method === "addWidget" || method === "addSection")
          return (child) => { (target[method === "addWidget" ? "widgets" : "sections"] ||= []).push(child); return proxy; };
        if (method === "addUpdateContent")
          return (content, contentType) => { target.content = content; target.contentType = contentType; return proxy; };
        if (typeof method === "string" && method.startsWith("set"))
          return (child) => { const key = method[3].toLowerCase() + method.slice(4); target[key] = child; return proxy; };
        return undefined;
      },
    });
    return proxy;
  }
  const service = {
    ContentType: { MUTABLE_HTML: "MUTABLE_HTML" },
    UpdateDraftBodyType: { IN_PLACE_INSERT: "IN_PLACE_INSERT" },
  };
  for (const name of ["CardBuilder", "CardHeader", "CardSection", "TextParagraph",
    "TextButton", "OpenLink", "TextInput", "Action", "ActionResponseBuilder",
    "Notification", "UpdateDraftActionResponseBuilder", "UpdateDraftBodyAction"])
    service[`new${name}`] = () => {
      if (failInsertion && name === "UpdateDraftActionResponseBuilder") throw new Error("No active draft");
      return builder(name);
    };
  const context = { CardService: service, console: { info() {} } };
  vm.createContext(context);
  new vm.Script(source).runInContext(context);
  return context;
}

function event(link, locale = "fr") {
  return { commonEventObject: { userLocale: locale,
    formInputs: { shareLink: { stringInputs: { value: [link] } } } } };
}

test("Gmail manifest authorizes execution and composing without reading mail or draft metadata", () => {
  assert.deepEqual(manifest.oauthScopes, [
    "https://www.googleapis.com/auth/gmail.addons.execute",
    "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
  ]);
  assert.equal(manifest.addOns.gmail.composeTrigger.draftAccess, "NONE");
  assert.deepEqual(manifest.addOns.common.openLinkUrlPrefixes, [`${origin}/`]);
});

test("Gmail homepage and compose pane explain the upload flow and only compose offers insertion", () => {
  const runtime = addon();
  for (const [locale, label] of [["fr", "Insérer le lien dans le mail"], ["en", "Insert link into email"]]) {
    const e = event("", locale);
    const home = runtime.homepage(e);
    const compose = runtime.composeAction(e);
    assert.equal(compose.header.imageUrl, manifest.addOns.common.logoUrl);
    const widgets = compose.sections[0].widgets;
    assert.ok(widgets.some((item) => item.fieldName === "shareLink"));
    assert.ok(widgets.some((item) => item.text === label && item.onClickAction.functionName === "insertShareLink"));
    assert.equal(home.sections[0].widgets.some((item) => item.fieldName === "shareLink"), false);
    assert.ok(widgets.some((item) => item.openLink?.url === `${origin}/upload?source=gmail-addon`));
  }
});

test("Gmail inserts the full encrypted share link at the cursor without altering recipients or sending", () => {
  const link = `${origin}/s/test-share?download=1&file=test#key=example_test_only_abcdefghijklmnop`;
  const response = addon().insertShareLink(event(link));
  assert.equal(response.type, "UpdateDraftActionResponseBuilder");
  assert.equal(response.updateDraftBodyAction.updateType, "IN_PLACE_INSERT");
  assert.equal(response.updateDraftBodyAction.contentType, "MUTABLE_HTML");
  assert.ok(response.updateDraftBodyAction.content.includes(link.replaceAll("&", "&amp;")));
  assert.deepEqual(Object.keys(response).sort(), ["type", "updateDraftBodyAction"]);
});

test("Gmail rejects malformed, foreign, executable and HTML-injected links with a readable notification", () => {
  const runtime = addon();
  for (const link of [undefined, null, {}, "", "javascript:alert(1)", "http://share.example.com/s/id",
    `${origin}.attacker.invalid/s/id`, "https://share.example.com@attacker.invalid/s/id",
    `${origin}/upload`, `${origin}/s/id\n#key=x`, `${origin}/s/id\" onclick=\"alert(1)`,
    `${origin}/s/id#<img src=x onerror=alert(1)>`, `${origin}/s/id\\evil`, "x".repeat(8193)]) {
    const response = runtime.insertShareLink(event(link));
    assert.equal(response.type, "ActionResponseBuilder");
    assert.ok(response.notification.text.includes("Collez le lien complet"));
  }
  assert.equal(runtime.insertShareLink({}).type, "ActionResponseBuilder");
});

test("Gmail provides manual-paste recovery when the draft update fails", () => {
  const response = addon({ failInsertion: true }).insertShareLink(event(`${origin}/s/test`, "en"));
  assert.ok(response.notification.text.includes("Paste it directly"));
});

